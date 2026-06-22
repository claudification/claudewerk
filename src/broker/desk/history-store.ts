/**
 * The per-user LIVING HISTORY store + live-block refresh (plan §3 B2).
 *
 * The dispatcher is a LIVING CONVERSATION, one per user, that we MUTATE each
 * impulse -- NOT a fresh single-shot snapshot. This module owns:
 *  - the in-memory per-user `LivingHistory` map (a working set; restart-loss is
 *    acceptable -- durable signal lives in project memory + recaps),
 *  - `refreshLiveBlocks`: rewrite the volatile state blocks (`<fleet>`, project
 *    `<briefs>`, durable `<notes>`) in place from the current fleet snapshot,
 *  - `consolidateIfDue`: run the gated fold (size-floor + interval, §8a) and track
 *    the per-user last-run clock.
 *
 * The rolling `<memory>` block (consolidation-owned) and async `<pending>`/
 * `<findings>` blocks are NOT touched here -- they mutate on their own triggers.
 */

import type { ChatFn } from './classify'
import { type ConsolidateResult, consolidate } from './consolidate'
import {
  createHistorySaver,
  type HistorySaver,
  loadAllHistories,
  type PersistableState,
  type PersistenceDeps,
} from './history-persistence'
import {
  createHistory,
  estimateTokens,
  type LivingHistory,
  ONE_HOUR_MS,
  type Role,
  shouldConsolidate,
  type Turn,
} from './living-history'
import { clearTranscriptByKey, getTranscriptByKey, recordTurnByKey, setTranscriptByKey } from './transcript-ring'

export { refreshLiveBlocks } from './live-blocks'

/** Sentinel key for an unauthenticated/anon dispatcher session. */
const ANON_KEY = '__anon__'

const histories = new Map<string, LivingHistory>()
const lastConsolidatedAt = new Map<string, number>()
/** The disk-backed saver, wired at boot via initHistoryPersistence. Null in unit
 *  tests / pre-boot -- markDirty is then a no-op so the store never touches disk. */
let saver: HistorySaver | null = null

export function userKey(userId: string | null | undefined): string {
  return userId && userId.trim() ? userId : ANON_KEY
}

/** Get (or lazily create) the persistent living history for a user. */
export function getUserHistory(userId: string | null | undefined): LivingHistory {
  const key = userKey(userId)
  let h = histories.get(key)
  if (!h) {
    h = createHistory()
    histories.set(key, h)
  }
  return h
}

/** Test/forensics seam: drop a user's history (e.g. an explicit reset). */
export function resetUserHistory(userId: string | null | undefined): void {
  const key = userKey(userId)
  histories.delete(key)
  lastConsolidatedAt.delete(key)
  clearTranscriptByKey(key)
  saver?.removeFile(key) // delete the persisted file too (Slice A)
}

/**
 * Load all persisted histories into the in-memory maps and arm the debounced
 * saver (Slice A). Called ONCE at broker boot from the cacheDir. After this,
 * `markDirty` writes mutations through to disk so the dispatcher survives a
 * restart. `deps` is injectable for tests (no real disk).
 */
export function initHistoryPersistence(cacheDir: string, deps?: PersistenceDeps): void {
  for (const [key, state] of loadAllHistories(cacheDir, deps)) {
    histories.set(key, state.history)
    if (state.lastConsolidatedAt !== null) lastConsolidatedAt.set(key, state.lastConsolidatedAt)
    setTranscriptByKey(key, state.transcript)
  }
  saver = createHistorySaver(cacheDir, deps)
}

/** Snapshot the current restart-survivable state for a user (the saver reads this
 *  lazily when the debounce fires, so it always serializes the latest mutation). */
function currentState(key: string): PersistableState {
  return {
    userKey: key,
    history: histories.get(key) ?? createHistory(),
    lastConsolidatedAt: lastConsolidatedAt.get(key) ?? null,
    transcript: getTranscriptByKey(key),
  }
}

/** Schedule a debounced persist of this user's state. A no-op until boot wiring
 *  arms the saver, so unit tests never touch disk. Call from EVERY mutation. */
export function markDirty(userId: string | null | undefined): void {
  if (!saver) return
  const key = userKey(userId)
  saver.scheduleSave(key, () => currentState(key))
}

/**
 * Record a turn into the VIEWABLE transcript ring (A0) -- the last 100
 * user/assistant turns kept for the user to scroll, decoupled from the LLM
 * context window. Call this everywhere a real dialogue turn is produced; it is
 * SEPARATE from the LivingHistory `appendTurn` that consolidation later prunes.
 */
export function recordTurn(userId: string | null | undefined, role: Role, content: string, ts: number): void {
  recordTurnByKey(userKey(userId), role, content, ts)
}

/** The user's viewable transcript ring (the last <=100 turns), for the overlay. */
export function getUserTranscript(userId: string | null | undefined): Turn[] {
  return getTranscriptByKey(userKey(userId))
}

/**
 * Run the consolidation fold IF the gated policy says it's due (§8a: size-floor
 * + interval, size-valve bypass). Tracks the per-user last-run clock so the
 * debounce is honored across impulses. Returns the result, or null when not due.
 */
export async function consolidateIfDue(
  h: LivingHistory,
  userId: string | null | undefined,
  now: number,
  chat: ChatFn,
): Promise<ConsolidateResult | null> {
  const key = userKey(userId)
  const lastRunAt = lastConsolidatedAt.get(key) ?? now - ONE_HOUR_MS
  if (!shouldConsolidate({ history: h, now, lastRunAt })) return null
  const res = await consolidate({ history: h, now }, chat)
  if (res.ran) {
    lastConsolidatedAt.set(key, now)
    markDirty(userId) // the fold mutated blocks/turns -- persist the folded state
  }
  return res
}

export interface DumpTurn {
  role: string
  content: string
  ts: number
}

export interface HistoryDump {
  exists: boolean
  userKey: string
  blocks: Array<{ id: string; tag: string; content: string; ts: number }>
  /** The LLM context-window turns (consolidation prunes these). */
  turns: DumpTurn[]
  /** The VIEWABLE transcript ring (last <=100), decoupled from pruning (A0). */
  transcript: DumpTurn[]
  estimatedTokens: number
  lastConsolidatedAt: number | null
}

const dumpTurns = (turns: Turn[]): DumpTurn[] => turns.map(t => ({ role: t.role, content: t.content, ts: t.ts }))

/** Full, inspectable snapshot of a user's living history (the debug harness reads
 *  this so the dispatcher's state/context/memory can be dumped over REST). The
 *  viewable `transcript` is returned even when the LLM window is empty/absent. */
export function dumpUserHistory(userId: string | null | undefined): HistoryDump {
  const key = userKey(userId)
  const transcript = dumpTurns(getTranscriptByKey(key))
  const h = histories.get(key)
  if (!h) {
    return {
      exists: false,
      userKey: key,
      blocks: [],
      turns: [],
      transcript,
      estimatedTokens: 0,
      lastConsolidatedAt: null,
    }
  }
  return {
    exists: true,
    userKey: key,
    blocks: [...h.blocks.values()].map(b => ({ id: b.id, tag: b.tag, content: b.content, ts: b.ts })),
    turns: dumpTurns(h.turns),
    transcript,
    estimatedTokens: estimateTokens(h),
    lastConsolidatedAt: lastConsolidatedAt.get(key) ?? null,
  }
}

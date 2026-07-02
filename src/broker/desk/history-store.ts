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

import type { DispatchHistoryDump, DispatchHistoryTurn } from '../../shared/protocol'
import type { ChatFn } from './classify'
import { type ConsolidateResult, consolidate, MEMORY_BLOCK_ID } from './consolidate'
import { type DreamResult, dreamCycle } from './dream-cycle'
import {
  createHistorySaver,
  type HistorySaver,
  loadAllHistories,
  type PersistableState,
  type PersistenceDeps,
} from './history-persistence'
import {
  agedTurns,
  createHistory,
  dropBlock,
  estimateTokens,
  type LivingHistory,
  ONE_HOUR_MS,
  type Role,
  shouldConsolidate,
  TEN_MIN_MS,
  type Turn,
} from './living-history'
import { clearTranscriptByKey, getTranscriptByKey, recordTurnByKey, setTranscriptByKey } from './transcript-ring'

export { refreshLiveBlocks } from './live-blocks'

/** Sentinel key for an unauthenticated/anon dispatcher session. */
const ANON_KEY = '__anon__'

const histories = new Map<string, LivingHistory>()
const lastConsolidatedAt = new Map<string, number>()
/** Per-user clock for the rare Opus dream-cycle re-ground (gated to once / day). */
const lastDreamAt = new Map<string, number>()
/** The disk-backed saver, wired at boot via initHistoryPersistence. Null in unit
 *  tests / pre-boot -- markDirty is then a no-op so the store never touches disk. */
let saver: HistorySaver | null = null
/** Live-stream notifier, armed at boot (Slice B). Pushes the fresh history to ALL
 *  of a user's open overlays on every mutation. Null pre-boot/in tests -> no-op. */
let notifier: ((userId: string | null | undefined) => void) | null = null

/** Arm the live-stream broadcaster (Slice B). The closure (built at boot, where
 *  the ConversationStore is available) dumps + broadcasts to the user's devices. */
export function setHistoryNotifier(fn: (userId: string | null | undefined) => void): void {
  notifier = fn
}

export function userKey(userId: string | null | undefined): string {
  return userId?.trim() ? userId : ANON_KEY
}

/** Every user with a living history (loaded from disk at boot or created this
 *  run) -- the dispatcher's user set. ANON decodes back to null. Attention
 *  impulses (N2) fan out to exactly these users. */
export function listHistoryUsers(): Array<string | null> {
  return [...histories.keys()].map(k => (k === ANON_KEY ? null : k))
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

/** Drop a user's history entirely (the user's `/clear`, or the dev reset seam):
 *  living history + viewable transcript + persisted file all go. Re-syncs every
 *  device so the fresh (empty) dispatcher streams out immediately. */
export function resetUserHistory(userId: string | null | undefined): void {
  const key = userKey(userId)
  histories.delete(key)
  lastConsolidatedAt.delete(key)
  lastDreamAt.delete(key)
  clearTranscriptByKey(key)
  saver?.removeFile(key) // delete the persisted file too (Slice A)
  // Notify-only re-sync: push the now-empty history to the user's open overlays
  // WITHOUT scheduling a save (markDirty would re-persist the file we just removed).
  notifier?.(userId)
}

/** The user's `/forget`: drop the rolling `<memory>` block only, keeping the recent
 *  conversation + transcript. Forgets the long-term recollection, not the chat. */
export function forgetUserMemory(userId: string | null | undefined): void {
  const key = userKey(userId)
  const h = histories.get(key)
  if (!h) return
  dropBlock(h, MEMORY_BLOCK_ID)
  markDirty(userId)
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

/**
 * Mark a user's state changed: broadcast it LIVE to all their devices (immediate,
 * Slice B) and schedule a debounced persist (Slice A). Called from EVERY mutation
 * entry point. Both seams no-op until boot arms them, so unit tests stay offline.
 */
export function markDirty(userId: string | null | undefined): void {
  notifier?.(userId) // live stream now (not debounced -- devices must stay in lockstep)
  if (!saver) return
  saver.scheduleSave(userKey(userId), () => currentState(userKey(userId)))
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

/** Below this, an OPEN does NOT re-fold (we condensed recently -- nothing stale). */
const STALE_ON_READ_MS = 15 * 60_000

/**
 * READ-TRIGGERED fold (the 30-hour fix). When the user OPENS the dispatcher after a
 * genuine gap, condense the aged-out turns into `<memory>` BEFORE the overlay renders
 * -- so returning shows a condensed memory, not the raw last conversation.
 *
 * AGE-gated, NOT size-gated: the 1500-tok size floor (`shouldConsolidate`) is a
 * HOT-PATH cost guard so we don't pay to fold a tiny live session every turn. But a
 * once-per-return fold IS worth a cent even for a small stale chat -- that is exactly
 * the case the user hit (a short chat left for 30h never crossed the floor, so it
 * never folded). So here we bypass the floor and fold whenever turns have aged past
 * the 1h horizon and we haven't folded recently. No-op (zero cost) otherwise.
 */
export async function consolidateOnOpen(
  userId: string | null | undefined,
  now: number,
  chat: ChatFn,
): Promise<ConsolidateResult | null> {
  const key = userKey(userId)
  const h = histories.get(key)
  if (!h) return null
  const lastRunAt = lastConsolidatedAt.get(key) ?? 0
  if (now - lastRunAt < STALE_ON_READ_MS) return null // folded recently -- nothing stale
  if (agedTurns(h, now).length === 0) return null // nothing past the 1h horizon -- no fold
  const res = await consolidate({ history: h, now }, chat) // bypass the size floor on return
  if (res.ran) {
    lastConsolidatedAt.set(key, now)
    markDirty(userId)
  }
  return res
}

/** Below this gap an OPEN does NOT re-ground (the Opus dream-cycle is rare by design). */
const DREAM_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Run the DREAM-CYCLE (Opus re-ground of `<memory>`) if it's been a day since the
 * last one for this user. The cheap live fold runs constantly and drifts; this is
 * the infrequent editor pass that de-dups + supersedes + tightens. Gated once/day
 * and skipped entirely on a short memory (dreamCycle no-ops), so the Opus cost is
 * negligible. No-op (null) when there's no history.
 */
async function dreamCycleIfDue(
  userId: string | null | undefined,
  now: number,
  chat: ChatFn,
): Promise<DreamResult | null> {
  const key = userKey(userId)
  const h = histories.get(key)
  if (!h) return null
  if (now - (lastDreamAt.get(key) ?? 0) < DREAM_INTERVAL_MS) return null
  lastDreamAt.set(key, now) // stamp the attempt even if memory was too short to dream
  const res = await dreamCycle(h, now, chat)
  if (res.ran) markDirty(userId)
  return res
}

/**
 * On-open MAINTENANCE (the return path): first the read-triggered fold (condense
 * aged turns -> the 30-hour fix), then the once-a-day dream-cycle re-ground. Both
 * are no-ops with zero LLM cost when not due. Fired-and-forgotten by the overlay
 * open handler; each mutation streams to all devices via markDirty.
 */
export async function maintainOnOpen(userId: string | null | undefined, now: number, chat: ChatFn): Promise<void> {
  await consolidateOnOpen(userId, now, chat)
  await dreamCycleIfDue(userId, now, chat)
}

/**
 * The user's `/compact`: force-fold the WHOLE current window into `<memory>` NOW,
 * regardless of age or the size floor (`maxAgeMs: 0` ages every turn), then drop the
 * raw turns. Condense-on-demand -- the explicit version of what phase-out does lazily.
 */
export async function compactNow(
  userId: string | null | undefined,
  now: number,
  chat: ChatFn,
): Promise<ConsolidateResult> {
  const h = getUserHistory(userId)
  const res = await consolidate({ history: h, now, maxAgeMs: 0 }, chat)
  if (res.ran) {
    lastConsolidatedAt.set(userKey(userId), now)
    markDirty(userId)
  }
  return res
}

/** The background fold heartbeat handle (armed at boot, cleared on shutdown/test). */
let heartbeat: ReturnType<typeof setInterval> | null = null

/**
 * BACKGROUND fold heartbeat (the "fold even if the user never returns" safety net).
 * Every interval, run the GATED fold (`consolidateIfDue` -- honors the size floor +
 * interval) for every live user, so memory forms in the background for big idle
 * sessions without the user typing. Tiny sessions are deliberately left to the
 * on-open fold (`consolidateOnOpen`) -- folding a 400-tok chat every 10 min would
 * be the net-cost waste §8a warns against. Returns a stop fn.
 */
export function startConsolidationHeartbeat(chat: ChatFn, intervalMs: number = TEN_MIN_MS): () => void {
  stopConsolidationHeartbeat()
  heartbeat = setInterval(() => {
    const now = Date.now()
    for (const [key, h] of histories) {
      consolidateIfDue(h, key === ANON_KEY ? null : key, now, chat).catch(() => {})
    }
  }, intervalMs)
  // Don't keep the broker process alive on this timer (tests, graceful shutdown).
  ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  return stopConsolidationHeartbeat
}

function stopConsolidationHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
}

/** The wire shape lives in shared/protocol (single source of truth, web-shared). */
export type HistoryDump = DispatchHistoryDump

const dumpTurns = (turns: Turn[]): DispatchHistoryTurn[] =>
  turns.map(t => ({ role: t.role, content: t.content, ts: t.ts }))

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

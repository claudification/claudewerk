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
  createHistory,
  estimateTokens,
  type LivingHistory,
  ONE_HOUR_MS,
  type Role,
  shouldConsolidate,
  type Turn,
  upsertBlock,
} from './living-history'
import type { ProjectOverviewRow } from './overview'
import { clearTranscriptByKey, getTranscriptByKey, recordTurnByKey } from './transcript-ring'

/** Sentinel key for an unauthenticated/anon dispatcher session. */
const ANON_KEY = '__anon__'
/** Default budget for the condensed project-briefs block (chars). Progressive
 *  memory: detail beyond this is reachable via the project_brief / recall tools. */
const DEFAULT_BRIEF_BUDGET_CHARS = 2400

const histories = new Map<string, LivingHistory>()
const lastConsolidatedAt = new Map<string, number>()

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

function fleetLine(r: ProjectOverviewRow): string | null {
  if (r.live === 0 && !r.brief) return null
  if (r.live === 0) return `- ${r.project}: idle (in memory)`
  const bits = [`${r.live} live`]
  if (r.working) bits.push(`${r.working} working`)
  if (r.needsYou) bits.push(`${r.needsYou} needs-you`)
  if (r.idleMin !== undefined) bits.push(`idle ${r.idleMin}m`)
  return `- ${r.project}: ${bits.join(', ')}`
}

/** Pack project briefs into a budget, most-relevant first (rows arrive ordered).
 *  Returns the block body + how many were dropped (reachable via tools). */
function packBriefs(rows: ProjectOverviewRow[], budget: number): { body: string; dropped: number } {
  const blocks: string[] = []
  let remaining = budget
  let dropped = 0
  for (const r of rows) {
    if (!r.brief) continue
    const block = `## ${r.project}\n${r.brief}`
    if (block.length + 2 <= remaining) {
      blocks.push(block)
      remaining -= block.length + 2
    } else {
      dropped++
    }
  }
  const tail = dropped ? `\n\n(+${dropped} more in memory -- use project_brief / recall)` : ''
  return { body: blocks.length ? blocks.join('\n\n') + tail : '', dropped }
}

export interface RefreshInput {
  rows: ProjectOverviewRow[]
  durableNotes: string
  now: number
  briefBudgetChars?: number
}

/**
 * Rewrite the volatile state blocks in place from the current fleet snapshot.
 * Each impulse calls this BEFORE appending the user turn, so the dispatcher
 * always reads a fresh `<fleet>` + `<briefs>` + `<notes>` without the context
 * accumulating -- the upsert REPLACES, never appends.
 */
export function refreshLiveBlocks(h: LivingHistory, input: RefreshInput): void {
  const { rows, now } = input
  const fleet = rows.map(fleetLine).filter((l): l is string => l !== null)
  if (fleet.length) upsertBlock(h, 'fleet', 'fleet', fleet.join('\n'), now)
  else h.blocks.delete('fleet')

  const { body } = packBriefs(rows, input.briefBudgetChars ?? DEFAULT_BRIEF_BUDGET_CHARS)
  if (body) upsertBlock(h, 'briefs', 'briefs', body, now)
  else h.blocks.delete('briefs')

  const notes = input.durableNotes.trim()
  if (notes) upsertBlock(h, 'notes', 'notes', notes, now)
  else h.blocks.delete('notes')
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
  if (res.ran) lastConsolidatedAt.set(key, now)
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

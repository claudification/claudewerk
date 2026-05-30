import type { StoreDriver } from '../../../store/types'
import { detectOpenLoopFromRecords } from './open-questions'
import { countTurnsByConversation } from './turns'
import type { ForgottenThread, ForgottenThreadDigest, PeriodScope } from './types'

const DAY_MS = 86_400_000

/** Tail entries probed per candidate to find the open loop. The final turn is
 *  what matters; a few extra give extractUserPromptsAndFinals its pairing. */
const TAIL_ENTRIES = 40
/** Max chars of the final assistant message carried into the prompt (the label
 *  only needs the gist; the full turn would bloat the synthesis input). */
const FINAL_TEXT_MAX = 600

export interface ForgottenOptions {
  /** "Now" in ms. Injectable for tests; defaults to Date.now(). */
  now?: number
  /** Floor: never flag a thread idle less than this, even on a sub-floor period.
   *  Default 2 days (Jonas forgets fast). */
  floorMs?: number
  /** Investment gate: minimum all-time recorded turns. Default 4. */
  minTurns?: number
  /** Max forgotten threads surfaced. Default 10. */
  cap?: number
  /** Max candidate tails to probe for an open loop before stopping (bounds the
   *  transcript reads -- the candidate pool can be hundreds). Default 40. */
  workingSet?: number
}

/**
 * FORGOTTEN THREADS (period-global, deterministic -- NOT map-extracted).
 *
 * Recap is period-boxed: it only gathers conversations active IN the window. A
 * forgotten thread has no recent activity, so it falls outside every other
 * gather. This pass reaches BEFORE the window and surfaces invested work that
 * was abandoned mid-loop.
 *
 * "Forgotten" = stale AND invested AND open-loop (all three, per Jonas):
 *   - stale:     last_activity < cutoff, where cutoff = min(periodStart, now-floor).
 *                Period-relative ("alpha"): a last_7 surfaces >7d-idle, last_30
 *                surfaces >30d-idle; the floor stops a sub-floor period flagging
 *                yesterday's work. cutoff <= periodStart always, so these never
 *                overlap the in-window conversation gather (no double-count).
 *   - invested:  >= minTurns all-time recorded turns (not a throwaway probe).
 *   - open-loop: the thread's final assistant turn ends on a question the user
 *                never answered. HARD FILTER -- "ended because done" is dropped.
 *                Threads with a pruned/empty transcript fail this naturally.
 *
 * Ranked by investment (turns) then abandonment (idleDays), capped. The
 * open-loop probe is bounded to `workingSet` tails; candidateCount reports the
 * full stale+invested pool so the caller can log/​surface what was not shown.
 */
/** A stale+invested candidate before the open-loop probe. */
type Candidate = Omit<ForgottenThread, 'lastUserPrompt' | 'finalAssistantText' | 'openQuestions'>

export function gatherForgotten(
  store: StoreDriver,
  scope: PeriodScope,
  opts: ForgottenOptions = {},
): ForgottenThreadDigest {
  const now = opts.now ?? Date.now()
  const cutoff = Math.min(scope.periodStart, now - (opts.floorMs ?? 2 * DAY_MS))
  const minTurns = opts.minTurns ?? 4

  const turnCounts = allTimeTurnCounts(store, scope, now)
  const candidates = collectCandidates(store, scope, { now, cutoff, minTurns }, turnCounts)
  // Rank: investment primary, abandonment secondary.
  candidates.sort((a, b) => b.turnCount - a.turnCount || b.idleDays - a.idleDays)

  const { threads, probed } = filterByOpenLoop(store, candidates, opts.cap ?? 10, opts.workingSet ?? 40)
  return { threads, candidateCount: candidates.length, probed }
}

/** Stale + invested conversations across every in-scope project (pre-open-loop). */
// fallow-ignore-next-line complexity
function collectCandidates(
  store: StoreDriver,
  scope: PeriodScope,
  gate: { now: number; cutoff: number; minTurns: number },
  turnCounts: Map<string, number>,
): Candidate[] {
  const out: Candidate[] = []
  for (const projectUri of scope.projectUris) {
    for (const s of store.conversations.listByScope(projectUri)) {
      if (s.status === 'active') continue // live, not forgotten
      const created = (s as { createdAt?: number }).createdAt ?? 0
      const lastActivity = (s as { lastActivity?: number }).lastActivity ?? created
      if (lastActivity >= gate.cutoff) continue // too recent (in/near window)
      const turnCount = turnCounts.get(s.id) ?? 0
      if (turnCount < gate.minTurns) continue // not invested
      out.push({
        conversationId: s.id,
        conversationTitle: (s as { title?: string }).title ?? '',
        projectUri,
        idleDays: Math.floor((gate.now - lastActivity) / DAY_MS),
        turnCount,
      })
    }
  }
  return out
}

/** Open-loop HARD FILTER: walk the ranked pool, reading each tail, keeping only
 *  threads that ended on an unanswered question, until the cap fills or the
 *  working set is exhausted (whichever comes first). */
// fallow-ignore-next-line complexity
function filterByOpenLoop(
  store: StoreDriver,
  candidates: Candidate[],
  cap: number,
  workingSet: number,
): { threads: ForgottenThread[]; probed: number } {
  const threads: ForgottenThread[] = []
  let probed = 0
  for (const c of candidates) {
    if (threads.length >= cap || probed >= workingSet) break
    probed++
    const open = detectOpenLoopFromRecords(store.transcripts.getLatest(c.conversationId, TAIL_ENTRIES))
    if (!open) continue // ended clean / pruned transcript -> not a loose end
    threads.push({
      ...c,
      lastUserPrompt: open.lastUserPrompt,
      finalAssistantText: truncate(open.finalAssistantText, FINAL_TEXT_MAX),
      openQuestions: open.openQuestions,
    })
  }
  return { threads, probed }
}

/** All-time recorded turns per conversation across in-scope projects (the
 *  investment signal). Mirrors loadWindowTurns but with an unbounded `from` so a
 *  thread last touched weeks ago still reports its true turn count. */
function allTimeTurnCounts(store: StoreDriver, scope: PeriodScope, now: number): Map<string, number> {
  const all = []
  for (const projectUri of scope.projectUris) {
    const { rows } = store.costs.queryTurns({ from: 0, to: now, projectUri, limit: 100_000 })
    all.push(...rows)
  }
  return countTurnsByConversation(all)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

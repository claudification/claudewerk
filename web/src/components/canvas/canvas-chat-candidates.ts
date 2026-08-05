/**
 * Who a canvas may connect its chat to: the ONLINE conversations of the canvas's
 * own project, ranked so the ones actually doing something come first.
 *
 * Two rules, both load-bearing (Jonas, 2026-08-05):
 *
 *  - LOCAL PROJECT ONLY. The broker refuses a cross-project connect anyway, so
 *    offering one would only produce a refusal.
 *  - ONLINE ONLY. `ended` conversations have no socket -- connecting to one
 *    "works" and then every send fails with "the connected conversation is
 *    offline right now". This project alone has ~800 dead conversations against
 *    a handful of live ones, so an unfiltered picker is a wall of corpses.
 *
 * Pure functions, no React: the ranking and the search are the parts worth
 * testing, and they should not need a renderer to be tested.
 */

import type { Conversation } from '@/lib/types'

/** The statuses that mean "there is something at the other end". */
export type OnlineStatus = 'active' | 'idle' | 'starting' | 'booting'

export interface ChatCandidate {
  id: string
  name: string
  status: OnlineStatus
}

/** Rank buckets: working first, coming-up second, waiting last. */
const STATUS_RANK: Record<OnlineStatus, number> = { active: 0, booting: 1, starting: 1, idle: 2 }

/** The subset of a conversation this module reads -- keeps the tests honest. */
export type CandidateSource = Pick<Conversation, 'id' | 'project' | 'status' | 'lastActivity' | 'title'>

function isOnline(status: string): status is OnlineStatus {
  return status in STATUS_RANK
}

/** Online conversations of `projectUri`, ranked by status then recency. */
export function liveCandidates(conversations: CandidateSource[], projectUri: string): ChatCandidate[] {
  return conversations
    .filter(c => c.project === projectUri && isOnline(c.status))
    .sort((a, b) => {
      const byRank = STATUS_RANK[a.status as OnlineStatus] - STATUS_RANK[b.status as OnlineStatus]
      return byRank !== 0 ? byRank : (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
    })
    .map(c => ({ id: c.id, name: c.title || c.id.slice(0, 8), status: c.status as OnlineStatus }))
}

/** Case-insensitive substring match on the name, with the id as a fallback so a
 *  pasted conversation id still finds its row. Blank query = everything. */
export function matchCandidates(candidates: ChatCandidate[], query: string): ChatCandidate[] {
  const q = query.trim().toLowerCase()
  if (!q) return candidates
  return candidates.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
}

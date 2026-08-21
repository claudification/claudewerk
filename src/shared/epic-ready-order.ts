/**
 * WHICH READY CARD GOES OUT FIRST -- the sort key behind `ready.slice(0, slots)`.
 *
 * There was no key. `triageDispatchLane` walks the cohort in board read order and
 * filters; nothing sorted the survivors, so which card took the last free seat was
 * an accident of how the board happened to be enumerated (mtime-descending, i.e.
 * WHATEVER WAS TOUCHED LAST). The only thing that ever perturbed that order was
 * `buildEpicIndex`'s bucket-then-priority sort, which cannot settle a tie between
 * two `high` cards -- and applies to the epic selector alone, never to
 * `planTagged`.
 *
 * The cost, observed four beats running: `epic-digest-shares-run-frontmatter` is
 * the head of a chain six cards deep, and it sat in `heldBack` on generations 2,
 * 3, 4 and 5 of `epic-project-runner` while leaves that block nothing took the
 * seats. At generation 5 every seat had ended and the ceiling was free; the engine
 * still picked `runner-run-delete-verb`, a leaf filed a day later and therefore
 * FIRST in the board read. Both cards were `high`, so priority would not have
 * settled it either. The defect is that NOTHING settled it.
 *
 * THE KEY, in order:
 *
 *   1. DESCENDING COUNT OF TRANSITIVE DEPENDENTS. Unblock the path first. This is
 *      the primary key and not a tiebreak, because it is the only term that knows
 *      anything about the shape of the work: a card six others are waiting on buys
 *      six cards' worth of parallelism the moment it lands, and a leaf buys none.
 *   2. `priority:`, high > medium > low -- the human's tiebreak, UNDERNEATH the
 *      DAG rather than above it. Priority-only is the design this card explicitly
 *      refuses: a `high` leaf still blocks nothing, and two `high` cards is the
 *      exact case that produced the bug.
 *   3. `created:` ASCENDING, so old work does not starve behind new work of equal
 *      rank -- the failure mode of the accidental mtime-descending order.
 *   4. `slug`, so the order is TOTAL. Without a final term the sort falls back on
 *      the incoming array, which is the accident this module exists to remove;
 *      a comparator that is deterministic only up to board order is not
 *      deterministic.
 *
 * MEASURED AGAINST THE WHOLE BOARD, not against the cohort, exactly as
 * `waitingOn` already is (`toEpicChild`). A card can perfectly well unblock work
 * that carries a different `epic:` or no tag at all, and that work is just as
 * blocked either way. Restricting the count to the cohort would make a card's
 * rank depend on which selector happened to ask.
 *
 * TERMINAL CARDS ARE NOT DEPENDENTS AND ARE NOT TRAVERSED THROUGH. A `done` card
 * is not waiting on anything, so counting it would inflate the rank of a card
 * whose dependents have all landed; and a chain that runs through a `done` card is
 * already severed -- `waitingOn` filters that dependency out, so the card behind
 * it is not blocked by this one in any sense the fold would recognise.
 *
 * PURE, and deliberately so: same board in, same order out, no clock, no I/O. A
 * dispatch order that changed between two reads of the same board would make
 * `heldBack` stop being the complement of `dispatch`, which is the one thing the
 * pane uses it to explain.
 */

import { cardPriorityRank, epicBucket } from './epic-cards'
import type { ProjectTaskMeta } from './project-task-types'

/** Terminal cards are out of the graph entirely -- see the header. */
function isLive(card: ProjectTaskMeta): boolean {
  const bucket = epicBucket(card.status)
  return bucket !== 'done' && bucket !== 'dropped'
}

/**
 * REVERSE `depends_on`: card id -> the LIVE cards that name it as a dependency.
 *
 * Built from the board rather than stored on the card for `epic-cards.ts`'s
 * reason: `blocks:` was a hand-maintained parent-side list, nothing kept it true,
 * and the inverse of a declared edge is always computable.
 */
function dependentEdges(board: readonly ProjectTaskMeta[]): Map<string, string[]> {
  const edges = new Map<string, string[]>()
  for (const card of board) {
    if (!isLive(card)) continue
    for (const dep of card.dependsOn ?? []) {
      const list = edges.get(dep)
      if (list) list.push(card.slug)
      else edges.set(dep, [card.slug])
    }
  }
  return edges
}

/**
 * How many live cards are transitively waiting on this one.
 *
 * A breadth-first walk of the reverse edges. The start id is seeded into `seen`
 * and never counted, which also makes a dependency cycle -- or a card that
 * somehow names itself -- terminate with a finite number rather than hang.
 */
function reachableFrom(id: string, edges: ReadonlyMap<string, readonly string[]>): number {
  const seen = new Set<string>([id])
  const queue = [id]
  for (let i = 0; i < queue.length; i += 1) {
    for (const next of edges.get(queue[i] as string) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen.size - 1
}

/**
 * The primary key on its own: card id -> how many live cards it transitively
 * unblocks, for every card in `ready`.
 *
 * Exported so the key is testable without building a whole plan, and so a pane
 * that wants to SAY why a card outranked another has the number rather than
 * having to re-derive it.
 */
export function unblockCounts(
  ready: readonly ProjectTaskMeta[],
  board: readonly ProjectTaskMeta[],
): Map<string, number> {
  const edges = dependentEdges(board)
  return new Map(ready.map(card => [card.slug, reachableFrom(card.slug, edges)]))
}

/** `created:` as a number, with the raw string as the fallback ordering when a
 *  card carries something unparseable -- a malformed date must not silently
 *  collapse into "oldest" and win every tiebreak it is in. */
function createdAt(card: ProjectTaskMeta): number {
  const ms = Date.parse(card.created)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

/**
 * READY CARDS, MOST IMPORTANT FIRST. The one place the dispatch order is decided.
 *
 * Returns a new array; the input is never mutated, because `triageDispatchLane`'s
 * output is also what `idleReason` reads and a sort in place would reorder it
 * under a caller that did not ask.
 */
export function orderReady(ready: readonly ProjectTaskMeta[], board: readonly ProjectTaskMeta[]): ProjectTaskMeta[] {
  const unblocks = unblockCounts(ready, board)
  return [...ready].sort((a, b) => {
    const byUnblocks = (unblocks.get(b.slug) ?? 0) - (unblocks.get(a.slug) ?? 0)
    if (byUnblocks !== 0) return byUnblocks
    const byPriority = cardPriorityRank(a) - cardPriorityRank(b)
    if (byPriority !== 0) return byPriority
    const byCreated = createdAt(a) - createdAt(b)
    if (byCreated !== 0) return byCreated
    return a.slug.localeCompare(b.slug)
  })
}

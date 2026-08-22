/**
 * DID THE WERK-PLANNER CHANGE THE BOARD? -- answered from the board, not from the
 * werk-planner's own account of itself.
 *
 * The checkpoint rule is "stop and show me if gen 0 rewrote my work", and the
 * cheap implementation is to ask the werk-planner whether it changed anything. That
 * is exactly the question a model is worst at: it has every incentive to
 * summarise, it may have forgotten a card it touched forty tool calls ago, and a
 * run that silently skips its checkpoint is indistinguishable from one that had
 * nothing to report.
 *
 * So the engine fingerprints the board itself, before and after. What it covers
 * is what a plan can change and what changes dispatch: which cards exist, what
 * lane they are in, and the ORDERING EDGES -- `depends_on` is the whole point of
 * the planning pass, so an edge added with no other change must still trip it.
 *
 * Deliberately NOT covered: title and body prose. The werk-planner is expected to
 * sharpen wording, and stopping the run to report a reworded card would train
 * you to click through the checkpoint, which is worse than not having one.
 */

import { buildEpicIndex } from './epic-cards'
import type { ProjectTaskMeta } from './project-task-types'

/** One card's dispatch-relevant identity. Sorted deps so declaration order,
 *  which changes nothing, cannot read as a change. */
function cardPrint(card: ProjectTaskMeta): string {
  const deps = [...(card.dependsOn ?? [])].sort().join(',')
  return `${card.slug}:${card.status}:${deps}`
}

/**
 * A stable string for one epic's children. Sorted, so the board's own ordering
 * (which is display, not meaning) never fakes a change.
 */
export function boardFingerprint(cards: readonly ProjectTaskMeta[], epicId: string): string {
  const rollup = buildEpicIndex(cards).get(epicId)
  if (!rollup) return ''
  return rollup.children
    .map(c => cardPrint(c.card))
    .sort()
    .join('|')
}

/** What actually moved, for the checkpoint message. Empty when nothing did. */
export function fingerprintDelta(before: string, after: string): { added: string[]; removed: string[] } {
  const from = new Set(before ? before.split('|') : [])
  const to = new Set(after ? after.split('|') : [])
  return {
    added: [...to].filter(p => !from.has(p)),
    removed: [...from].filter(p => !to.has(p)),
  }
}

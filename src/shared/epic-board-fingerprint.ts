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

/** The three parts of a print, back apart again. Split on the FIRST two colons
 *  only: a card slug and a lane cannot contain one, and the dependency list is
 *  comma-separated, so everything after the second colon is edges. */
function unprint(print: string): { slug: string; status: string; deps: string[] } {
  const [slug = '', status = '', ...rest] = print.split(':')
  const deps = rest.join(':')
  return { slug, status, deps: deps ? deps.split(',') : [] }
}

const list = (deps: readonly string[]) => (deps.length === 0 ? 'nothing' : deps.join(', '))

/** What changed about ONE card that exists on both sides. Empty when the two
 *  prints differ in no way this function knows how to name, which cannot happen
 *  while `cardPrint` carries exactly a lane and a dependency list -- and if a
 *  fourth component is ever added, an unnamed change is the loud failure. */
function cardChanges(before: string, after: string): string[] {
  const a = unprint(before)
  const b = unprint(after)
  const out: string[] = []
  if (a.status !== b.status) out.push(`${a.slug}: lane ${a.status} -> ${b.status}`)
  if (a.deps.join(',') !== b.deps.join(',')) {
    out.push(`${a.slug}: depends_on ${list(a.deps)} -> ${list(b.deps)}`)
  }
  return out.length > 0 ? out : [`${a.slug}: changed (${before} -> ${after})`]
}

/**
 * WHAT THE RE-PLAN ACTUALLY CHANGED, CARD BY CARD, IN WORDS.
 *
 * `fingerprintDelta` above answers "did anything move" and is enough for a gate;
 * it is NOT enough for a notification. A leg boundary re-plans and CARRIES ON, so
 * the baton entry is the only account Jonas gets of a model reshaping his board
 * while he was not watching -- and `+4/-3 card states` is not an account, it is a
 * receipt for one. This names the cards.
 *
 * PAIRED BY SLUG, which is what makes a MODIFIED card one line instead of two. A
 * card whose lane moved appears in `added` and `removed` both, and reporting it as
 * a new card plus a deleted card is how a re-plan that closed three cards reads
 * like one that deleted three.
 *
 * THE EDGE REWRITE IS THE LINE THIS EXISTS FOR. Rewriting `depends_on` against the
 * code as it now stands is the whole job of a re-plan, and it is the change that
 * is invisible everywhere else: no card appears, none disappears, no lane moves,
 * and the next beat simply dispatches a different set. `cardPrint` puts the sorted
 * edges in the fingerprint precisely so this can be seen, and this is where it is
 * said out loud.
 */
export function describeBoardDelta(before: string, after: string): string[] {
  const from = new Map([...(before ? before.split('|') : [])].map(p => [unprint(p).slug, p]))
  const to = new Map([...(after ? after.split('|') : [])].map(p => [unprint(p).slug, p]))
  const out: string[] = []
  for (const [slug, print] of to) {
    const was = from.get(slug)
    if (was === undefined) {
      const c = unprint(print)
      out.push(`${slug}: NEW (${c.status}, depends on ${list(c.deps)})`)
    } else if (was !== print) {
      out.push(...cardChanges(was, print))
    }
  }
  for (const [slug, print] of from) {
    if (!to.has(slug)) out.push(`${slug}: GONE (was ${unprint(print).status})`)
  }
  return out.sort()
}

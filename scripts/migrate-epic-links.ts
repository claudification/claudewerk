#!/usr/bin/env bun
/**
 * Promote hand-rolled epic linkage (`blocks:` on the epic, the epic's id buried
 * in a child's `refs:`) to the one key anything reads: `epic:` on the child.
 *
 * DRY RUN BY DEFAULT. Pass --write to actually touch cards.
 *
 *   bun scripts/migrate-epic-links.ts [--write] [--root <project-root>]
 *
 * Idempotent: a card that already carries `epic:` is never re-decided, so a
 * human's correction survives every future run. A child claimed by two epics is
 * reported and skipped -- guessing which parent wins is exactly the kind of
 * silent wrong answer this whole exercise exists to kill.
 */

import { planEpicMigration } from '../src/shared/epic-migrate'
import { readRawCard } from '../src/shared/project-card-file'
import { locateCard, readFileOrNull } from '../src/shared/project-card-read'
import { getProjectTask, listProjectTasks, updateProjectTask } from '../src/shared/project-store'

const args = process.argv.slice(2)
const write = args.includes('--write')
const rootIdx = args.indexOf('--root')
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd()

/** The epic-side `blocks:` list, read raw -- the wire shape does not carry it. */
function readBlocks(id: string): string[] {
  const found = locateCard(root, id)
  if (!found) return []
  const raw = readRawCard(found.abs, readFileOrNull(found.abs))
  const val = raw?.meta.blocks
  return Array.isArray(val) ? val.map(String) : []
}

const metas = listProjectTasks(root)
const cards = metas.map(m => getProjectTask(root, m.slug)).filter(c => c !== null)

const blocksByEpic = new Map<string, string[]>()
for (const card of cards) {
  if (card.tags.includes('epic')) blocksByEpic.set(card.slug, readBlocks(card.slug))
}

const plan = planEpicMigration(cards, blocksByEpic)

console.log(`board: ${root}`)
console.log(`cards: ${cards.length}   epics: ${plan.epicIds.length}   [${plan.epicIds.join(', ')}]`)
console.log(`\n${plan.assignments.length} assignment(s):`)
for (const a of plan.assignments) {
  console.log(`  ${a.childId}  ->  epic: ${a.epicId}   (${a.via})`)
}

if (plan.conflicts.length > 0) {
  console.log(`\n${plan.conflicts.length} CONFLICT(s) -- skipped, resolve by hand:`)
  for (const c of plan.conflicts) console.log(`  ${c.childId}  claimed by  ${c.epicIds.join(' + ')}`)
}
if (plan.danglingChildren.length > 0) {
  console.log(`\n${plan.danglingChildren.length} dangling child id(s) -- listed but no such card:`)
  for (const d of plan.danglingChildren) console.log(`  ${d}`)
}

if (!write) {
  console.log(`\nDRY RUN -- nothing written. Re-run with --write to apply.`)
  process.exit(0)
}

let applied = 0
for (const a of plan.assignments) {
  if (updateProjectTask(root, a.childId, { epic: a.epicId })) applied++
  else console.error(`  FAILED to write ${a.childId}`)
}
console.log(`\nwrote epic: onto ${applied}/${plan.assignments.length} card(s).`)

// Touch nothing else. `blocks:` stays on disk: it still means "runs before" on
// the cards that used it that way, and this script is not the thing that gets
// to decide those are safe to delete.

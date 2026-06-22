/**
 * The volatile STATE BLOCKS the dispatcher reads each turn (`<fleet>`, `<briefs>`,
 * `<notes>`), rebuilt in place from the current fleet snapshot. Split out of
 * history-store so each module stays a single concern: this owns block FORMATTING
 * from a ProjectOverviewRow set; history-store owns the per-user store lifecycle.
 *
 * `refreshLiveBlocks` REWRITES (upserts) these blocks -- it never appends -- so
 * the context never accumulates; aged dialogue is what consolidation prunes.
 */

import { type LivingHistory, upsertBlock } from './living-history'
import type { ProjectOverviewRow } from './overview'

/** Default budget for the condensed project-briefs block (chars). Progressive
 *  memory: detail beyond this is reachable via the project_brief / recall tools. */
const DEFAULT_BRIEF_BUDGET_CHARS = 2400

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

interface RefreshInput {
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

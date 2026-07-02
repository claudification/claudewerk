/**
 * The volatile STATE BLOCKS the dispatcher reads each turn (`<fleet>`, `<threads>`,
 * `<briefs>`, `<notes>`), rebuilt in place from the current fleet snapshot. Split
 * out of history-store so each module stays a single concern: this owns block
 * FORMATTING from a ProjectOverviewRow set; history-store owns the per-user store
 * lifecycle.
 *
 * `refreshLiveBlocks` REWRITES (upserts) these blocks -- it never appends -- so
 * the context never accumulates; aged dialogue is what consolidation prunes.
 *
 * THREADS are the dispatcher's SHORT-TERM MEMORY ("what we're doing now") -- they
 * are folded into the per-turn context here, NOT rendered as a UI panel. They sit
 * above project briefs in recency by nature (current work, not durable memory).
 */

import type { DispatchThread } from '../../shared/protocol'
import { type LivingHistory, upsertBlock } from './living-history'
import type { ProjectOverviewRow } from './overview'

/** Default budget for the condensed project-briefs block (chars). Progressive
 *  memory: detail beyond this is reachable via the project_brief / recall tools. */
const DEFAULT_BRIEF_BUDGET_CHARS = 2400

/** How many near-memory threads to fold into the per-turn context (most-recent
 *  first). The rest stay reachable via the list_threads tool. */
const DEFAULT_THREAD_LIMIT = 8

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

/** Render the near-memory threads as compact lines (most-recent first). Each is
 *  one short "what we're doing" entry: title + an optional clipped summary. */
function packThreads(threads: DispatchThread[], limit: number): string {
  const lines: string[] = []
  for (const t of threads.slice(0, limit)) {
    const summary = t.summary?.trim()
    lines.push(summary ? `- ${t.title}: ${summary}` : `- ${t.title}`)
  }
  return lines.join('\n')
}

interface RefreshInput {
  rows: ProjectOverviewRow[]
  durableNotes: string
  now: number
  /** The dispatcher's near-memory threads -- short-term "what we're doing now". */
  threads?: DispatchThread[]
  /** Pre-rendered State of the Union body (sotu-context.ts): distilled narrative
   *  + git alerts + CONTENDED collisions -- the fleet truth, always in context. */
  sotu?: string
  briefBudgetChars?: number
  threadLimit?: number
}

/**
 * Rewrite the volatile state blocks in place from the current fleet snapshot.
 * Each impulse calls this BEFORE appending the user turn, so the dispatcher
 * always reads a fresh `<fleet>` + `<threads>` + `<briefs>` + `<notes>` without
 * the context accumulating -- the upsert REPLACES, never appends.
 *
 * `<threads>` (short-term memory) is rendered ahead of `<briefs>` (durable
 * project memory): current work outranks learned-but-quiet memory in recency.
 */
export function refreshLiveBlocks(h: LivingHistory, input: RefreshInput): void {
  const { rows, now } = input
  const fleet = rows.map(fleetLine).filter((l): l is string => l !== null)
  if (fleet.length) upsertBlock(h, 'fleet', 'fleet', fleet.join('\n'), now)
  else h.blocks.delete('fleet')

  const threadsBody = packThreads(input.threads ?? [], input.threadLimit ?? DEFAULT_THREAD_LIMIT)
  if (threadsBody) upsertBlock(h, 'threads', 'threads', threadsBody, now)
  else h.blocks.delete('threads')

  const sotu = input.sotu?.trim()
  if (sotu) upsertBlock(h, 'sotu', 'sotu', sotu, now)
  else h.blocks.delete('sotu')

  const { body } = packBriefs(rows, input.briefBudgetChars ?? DEFAULT_BRIEF_BUDGET_CHARS)
  if (body) upsertBlock(h, 'briefs', 'briefs', body, now)
  else h.blocks.delete('briefs')

  const notes = input.durableNotes.trim()
  if (notes) upsertBlock(h, 'notes', 'notes', notes, now)
  else h.blocks.delete('notes')
}

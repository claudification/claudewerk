/**
 * A1 BLOCKED ON YOU -- the questions you can answer without leaving the wall.
 *
 * On 2026-08-19 a dialog sat open and unanswered for twelve minutes inside a
 * fleet of ~100 conversations with nothing on any surface saying so. This pane is
 * that surface, and it ANSWERS: the buttons are the conversation's own answer
 * paths, so a permission allowed here is indistinguishable from one allowed in
 * the transcript.
 *
 * TWO TIERS, NEVER ONE LIST. HARD is a real block -- the agent is parked inside a
 * tool call. SOFT is `needs_you`, which agents raise as readily for "here is my
 * result, what next?" as for a genuine stop. Thirty soft asks must never bury one
 * hard block, which is exactly what a merged list does.
 *
 * Feed: `use-attention-queue.ts`. Fold: `attention-queue.ts`.
 */

import { useNowTick } from '@/components/pulse/use-pulse-fleet'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { ATTENTION_KEYS, type AttentionEntry } from '../attention-entries'
import { useAttentionKeys } from '../attention-keys'
import { AttentionRow } from '../attention-row'
import { useAttentionQueue } from '../use-attention-queue'
import { WallPane } from '../wall-pane'

/**
 * `managed` is DELIBERATELY not declared. The grammar hides machine-dispatched
 * rows by default, and an undeclared axis is cleared to "hide nothing" -- which
 * is the only correct default here, because epic seats and nightshift runs are
 * precisely the conversations that block on a permission with nobody watching.
 * `$` and `%` are absent for the ordinary reason: a pending question has no
 * spend and no context pressure, so it must not blank the pane.
 */
const AXES = ['text', 'band', 'project', 'tag', 'time', 'host', 'model'] as const

function Tier({
  label,
  rows,
  numbers,
  now,
}: {
  label: string
  rows: AttentionEntry[]
  numbers: Map<string, number>
  now: number
}) {
  if (rows.length === 0) return null
  return (
    <>
      <h3 className="wall-att-tier" data-tier={rows[0]?.tier}>
        {label}
        <span className="wall-att-tier-n">{rows.length}</span>
      </h3>
      <ul className="wall-att-list" data-tier={rows[0]?.tier}>
        {rows.map(entry => (
          <AttentionRow key={entry.key} entry={entry} index={numbers.get(entry.key)} now={now} />
        ))}
      </ul>
    </>
  )
}

export default function AttentionPane() {
  const now = useNowTick()
  const queue = useAttentionQueue(now)
  const { rows, matched, total } = useWallFilter(queue, AXES, entry => ({
    title: entry.title,
    project: entry.project,
    action: entry.question,
    tag: entry.tag,
    ageMs: Math.max(0, now - entry.since),
    band: entry.band,
    host: entry.host,
    model: entry.model,
  }))

  // The digits follow the DISPLAYED order across both tiers, so 1 is always the
  // thing at the top of the pane -- and they follow the FILTERED rows, because
  // answering something you cannot see is the worst outcome available.
  const numbers = new Map(rows.slice(0, ATTENTION_KEYS).map((r, i) => [r.key, i + 1]))
  useAttentionKeys(rows)

  const hard = rows.filter(r => r.tier === 'hard')
  const soft = rows.filter(r => r.tier === 'soft')

  return (
    <WallPane title="BLOCKED ON YOU" code="A1" maxHeight="34%" count={`${matched}/${total} waiting`}>
      {rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0 ? 'nobody is waiting on you' : 'nothing waiting matches'}
        </p>
      ) : (
        <>
          <Tier label="HARD -- stopped until you answer" rows={hard} numbers={numbers} now={now} />
          <Tier label="SOFT -- says it needs you" rows={soft} numbers={numbers} now={now} />
        </>
      )}
    </WallPane>
  )
}

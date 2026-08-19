/**
 * The whole board by count, to scale, in 22px.
 *
 * It answers "how organised is this board" before you read a word -- 8% of this
 * one belongs to an epic. That question had no answer anywhere in the panel,
 * and the closest thing to one was a footer warning that lumped 233 finished
 * cards in with 138 live ones.
 *
 * Finished work is deliberately drawn in greys. It is the largest share of any
 * mature board and colouring it would make an archive look like activity.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { cn } from '@/lib/utils'

interface Segment {
  key: string
  count: number
  label: string
  color: string
  /** Only wide segments get their label drawn inside them. */
  showLabel: boolean
}

function pct(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-read font-bold tabular-nums text-foreground">{value}</span>
      <span className="text-chrome text-fg-muted">{label}</span>
    </span>
  )
}

export function AllocationStrip({
  rollups,
  liveLoose,
  finishedLoose,
  total,
}: {
  rollups: EpicRollup[]
  liveLoose: number
  finishedLoose: number
  total: number
}) {
  if (total === 0) return null

  const parented = rollups.reduce((n, r) => n + r.children.length, 0)
  const segments: Segment[] = [
    ...rollups
      .filter(r => r.children.length > 0)
      .map(r => ({
        key: r.epicId,
        count: r.children.length,
        label: r.card?.title ?? r.epicId,
        color: `oklch(0.72 0.07 ${epicHue(r.epicId, r.card?.color)})`,
        showLabel: false,
      })),
    {
      key: '__live__',
      count: liveLoose,
      label: `${liveLoose} live, no epic`,
      color: 'color-mix(in oklab, var(--muted-foreground) 34%, transparent)',
      showLabel: true,
    },
    {
      key: '__finished__',
      count: finishedLoose,
      label: `${finishedLoose} finished`,
      color: 'color-mix(in oklab, var(--muted-foreground) 13%, transparent)',
      showLabel: true,
    },
  ].filter(s => s.count > 0)

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-[22px]">
        {segments.map(seg => (
          <div
            key={seg.key}
            title={`${seg.label} -- ${seg.count} cards`}
            style={{ width: `${pct(seg.count, total)}%`, background: seg.color }}
            className={cn(
              'flex items-center justify-center overflow-hidden whitespace-nowrap border-r border-background',
              'text-chrome text-foreground/85',
            )}
          >
            {seg.showLabel && pct(seg.count, total) > 12 ? seg.label : ''}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-x-5 gap-y-1 flex-wrap px-3 py-1 font-mono">
        <Stat value={String(total)} label="CARDS" />
        <Stat value={`${Math.round(pct(parented, total))}%`} label="IN AN EPIC" />
        <Stat value={`${Math.round(pct(liveLoose, total))}%`} label="LIVE AND UNOWNED" />
        <Stat value={`${Math.round(pct(finishedLoose, total))}%`} label="FINISHED" />
      </div>
    </div>
  )
}

/**
 * GroupHeader -- the `┌── LABEL ── timestamp ──` bar above a user/assistant
 * group, plus its badge row (channel, effort, via-skill, queued). Split out of
 * group-view.tsx. Seq-bucket continuation groups skip this header entirely so
 * a size-bound split reads as one uninterrupted turn.
 */
import { cn } from '@/lib/utils'
import { TimeStamp } from './timestamp'

export function GroupHeader({
  label,
  customColor,
  borderColor,
  labelBg,
  sizeClass,
  channelServer,
  effortBadge,
  attributionSkill,
  queued,
  ts,
}: {
  label: string
  customColor: string
  borderColor: string
  labelBg: string
  sizeClass: string
  channelServer?: string
  effortBadge: { symbol: string; label: string } | null
  attributionSkill?: string
  queued?: boolean
  ts?: string | number
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className={cn('text-[10px]', borderColor)}>{'┌──'}</span>
      <span
        className={cn('px-2 py-0.5 font-bold', sizeClass, !customColor && labelBg)}
        style={customColor ? { backgroundColor: customColor, color: '#0a0a0a' } : undefined}
      >
        {label}
      </span>
      {channelServer &&
        (channelServer === 'rclaude' ? (
          <span className="text-[9px] text-teal-400/50 font-mono">via channel</span>
        ) : (
          <span className="px-1.5 py-0.5 text-[10px] font-bold bg-teal-400/20 text-teal-400 border border-teal-400/50 animate-pulse">
            CHANNEL: {channelServer}
          </span>
        ))}
      {effortBadge && (
        <span className="px-1.5 py-0.5 text-[10px] font-bold bg-orange-400/20 text-orange-400">
          {effortBadge.symbol} {effortBadge.label}
        </span>
      )}
      {attributionSkill && (
        <span className="px-1.5 py-0.5 text-[10px] font-mono text-teal-400/80 bg-teal-400/10 border border-teal-400/30">
          via /{attributionSkill}
        </span>
      )}
      {queued && (
        <span className="px-1.5 py-0.5 text-[10px] font-mono text-amber-400/70 bg-amber-400/10 animate-pulse">
          queued
        </span>
      )}
      <TimeStamp ts={ts} className="text-muted-foreground text-[10px]" />
      <span className={cn('flex-1 text-[10px] overflow-hidden', borderColor)}>{'─'.repeat(40)}</span>
    </div>
  )
}

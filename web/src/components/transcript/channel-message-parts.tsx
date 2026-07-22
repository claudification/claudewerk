import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Shared presentation primitives for inter-conversation messages, keyed on
// DIRECTION. Incoming (received from another conversation) and outgoing (sent
// via the send_message tool) used to render with the identical teal card, so
// the only thing telling them apart was the tiny `from` / `to` word -- a
// text-only cue with no preattentive signal. These parts encode direction
// three redundant ways (hue + arrow chip + mirrored edge accent) so the two
// read as opposites at a glance, and they stay color-blind safe because the
// arrow glyph and the IN/OUT label carry the direction without relying on hue.

export type ChannelDirection = 'in' | 'out'

interface DirectionTheme {
  /** Card wrapper: subtle fill + hue border + mirrored edge accent bar. */
  card: string
  /** Direction chip (arrow + IN/OUT). */
  chip: string
  /** Glyph: triangle pointing INTO the timeline (in) vs leaving it (out). */
  glyph: string
  /** Short label. */
  label: string
}

const DIRECTION_THEME: Record<ChannelDirection, DirectionTheme> = {
  in: {
    card: 'border-teal-500/30 bg-teal-500/5 border-l-2 border-l-teal-400',
    chip: 'bg-teal-500/15 text-teal-300 border-teal-400/40',
    glyph: '◀', // ◀ pointing left -- arriving from outside
    label: 'IN',
  },
  out: {
    card: 'border-indigo-500/30 bg-indigo-500/5 border-r-2 border-r-indigo-400',
    chip: 'bg-indigo-500/15 text-indigo-300 border-indigo-400/40',
    glyph: '▶', // ▶ pointing right -- leaving for elsewhere
    label: 'OUT',
  },
}

// The voice orb is neither a peer conversation nor a system notice -- give it its
// own hue (violet) so a "from Orb" card never reads as another agent messaging in.
// Direction (in/out) still shows via the arrow glyph + edge side.
const ORB_CHIP = 'bg-violet-500/15 text-violet-300 border-violet-400/40'
function orbCard(direction: ChannelDirection): string {
  const edge = direction === 'in' ? 'border-l-2 border-l-violet-400' : 'border-r-2 border-r-violet-400'
  return `border-violet-500/30 bg-violet-500/5 ${edge}`
}

/** `◀ IN` (teal) or `OUT ▶` (indigo); violet when `orb`. Arrow on the outer edge. */
export function DirectionChip({ direction, orb }: { direction: ChannelDirection; orb?: boolean }) {
  const t = DIRECTION_THEME[direction]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded',
        orb ? ORB_CHIP : t.chip,
      )}
    >
      {direction === 'in' ? (
        <>
          <span aria-hidden>{t.glyph}</span>
          {t.label}
        </>
      ) : (
        <>
          {t.label}
          <span aria-hidden>{t.glyph}</span>
        </>
      )}
    </span>
  )
}

const INTENT_BADGE_STYLES: Record<string, string> = {
  request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
  response: 'bg-green-400/15 text-green-400 border-green-400/30',
  notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
}

export function IntentBadge({ intent }: { intent?: string }) {
  if (!intent) return null
  const style = INTENT_BADGE_STYLES[intent] || INTENT_BADGE_STYLES.notify
  return (
    <span className={cn('px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider border rounded', style)}>
      {intent}
    </span>
  )
}

/** Direction-tinted body card (rounded fill + mirrored edge accent); violet when
 *  `orb`. */
export function ChannelBodyCard({
  direction,
  orb,
  className,
  children,
}: {
  direction: ChannelDirection
  orb?: boolean
  className?: string
  children: ReactNode
}) {
  const card = orb ? orbCard(direction) : DIRECTION_THEME[direction].card
  return <div className={cn('rounded-lg border px-3 py-2.5 my-1', card, className)}>{children}</div>
}

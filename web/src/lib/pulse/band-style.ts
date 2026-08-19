import type { PulseBand } from './bands'

/**
 * One style table for every Pulse surface, so the palette, the strip and the
 * tide can never drift apart on what "needs you" looks like.
 *
 * Hues deliberately match STATUS_META (`status-style.ts`) — amber = wants you,
 * sky = working, emerald = done — because those are already the app's colour
 * vocabulary for agent state. Pulse adds the three bands `set_status` has no
 * word for: blocked, idle and expired.
 *
 * `blocked` is the one deliberate escalation: rose, the only alarm hue on the
 * surface, and the only band with a fill you notice without reading. An agent
 * parked on a dialog is stopped dead until you act, and that has to be legible
 * from across the room.
 */
export interface PulseBandStyle {
  label: string
  /** Single glyph used as the row bullet. */
  icon: string
  text: string
  dot: string
  border: string
  /** Faint fill for the NEEDS YOU card treatment on mobile. */
  bg: string
}

export const PULSE_BAND_STYLE: Record<PulseBand, PulseBandStyle> = {
  blocked: {
    label: 'BLOCKED ON YOU',
    icon: '■', // ■
    text: 'text-rose-400',
    dot: 'bg-rose-400',
    border: 'border-rose-400/40',
    bg: 'bg-rose-400/10',
  },
  needs: {
    label: 'NEEDS YOU',
    icon: '◆', // ◆
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    border: 'border-amber-400/30',
    bg: 'bg-amber-400/5',
  },
  working: {
    label: 'WORKING',
    icon: '▸', // ▸
    text: 'text-sky-400',
    dot: 'bg-sky-400',
    border: 'border-sky-400/20',
    bg: 'bg-sky-400/5',
  },
  done: {
    label: 'JUST DONE',
    icon: '✓', // ✓
    text: 'text-emerald-400',
    dot: 'bg-emerald-400',
    border: 'border-emerald-400/20',
    bg: 'bg-emerald-400/5',
  },
  idle: {
    label: 'IDLE',
    icon: '○', // ○
    text: 'text-accent',
    dot: 'bg-accent',
    border: 'border-accent/20',
    bg: 'bg-accent/5',
  },
  expired: {
    label: 'EXPIRED',
    icon: '·', // ·
    text: 'text-comment',
    dot: 'bg-comment',
    border: 'border-comment/20',
    bg: 'bg-comment/5',
  },
}

import type { SheafStatus } from '@shared/sheaf-types'

export const STATUS_GLYPH: Record<SheafStatus, string> = {
  running: '●',
  idle: '◐',
  ended: '◑',
  killed: '◯',
  crashed: '✕',
}

export const STATUS_COLOR: Record<SheafStatus, string> = {
  running: 'text-emerald-400',
  idle: 'text-sky-400',
  ended: 'text-zinc-400',
  killed: 'text-orange-400',
  crashed: 'text-rose-400',
}

export const STATUS_ORDER: SheafStatus[] = ['running', 'idle', 'ended', 'killed', 'crashed']

export const STATUS_BG: Record<SheafStatus, string> = {
  running: 'bg-emerald-500/10 border-emerald-500/30',
  idle: 'bg-sky-500/10 border-sky-500/30',
  ended: 'bg-zinc-500/10 border-zinc-500/30',
  killed: 'bg-orange-500/10 border-orange-500/30',
  crashed: 'bg-rose-500/10 border-rose-500/30',
}

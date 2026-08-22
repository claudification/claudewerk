/**
 * Sidebar tone per DERIVED vitality -- never per the raw `status` field.
 *
 * THE WALL already tones this, but as `data-vitality` attributes styled from
 * `wall.css`, which `wall-surface.tsx` imports -- and the wall is LAZY. Reusing
 * `RunTag` here would drag wall code into the index bundle (LAZY LOAD covenant)
 * and still render untoned until the wall had been opened once. So the sidebar
 * carries Tailwind classes for the same seven states.
 *
 * The SEMANTICS are not duplicated: `runVitality()` decides which state a run is
 * in, and this map only says what colour that state is. If the enum grows a
 * member, the fallback keeps the row rendering.
 */

import type { RunVitality } from '@shared/epic-vitality'

export const VITALITY_TONE: Record<RunVitality, string> = {
  working: 'text-emerald-400',
  idle: 'text-fg-dim',
  stalled: 'text-amber-400',
  paused: 'text-sky-400',
  done: 'text-emerald-400/70',
  aborted: 'text-destructive',
  unknown: 'text-fg-faint',
}

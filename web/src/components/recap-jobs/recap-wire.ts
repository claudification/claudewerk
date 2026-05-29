/**
 * Wire helper for `recap_create` -- extracted from recap-submenu so the
 * custom-range dialog can dispatch a recap without importing the submenu
 * (the submenu also imports the dialog, which would form a cycle).
 */

import type { RecapPeriodLabel } from '@shared/protocol'
import { wsSend } from '@/hooks/use-conversations'

function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof tz === 'string' && tz.length > 0) return tz
  } catch {
    /* fall through */
  }
  return 'UTC'
}

export interface CreateRecapOptions {
  projectUri: string
  label: RecapPeriodLabel
  start?: number
  end?: number
  signals?: string[]
  force?: boolean
  /** Opt into the evaluative retrospective (went well / badly / recommendations).
   *  Top-level product mode on recap_create -- NOT a tuning knob. */
  retrospect?: boolean
}

/** Send recap_create over the dashboard WS. Returns whether the send was
 *  attempted (false only when the WS is not OPEN). */
export function createRecap(opts: CreateRecapOptions): boolean {
  const period: { label: RecapPeriodLabel; start?: number; end?: number } = { label: opts.label }
  if (opts.label === 'custom') {
    if (opts.start == null || opts.end == null) return false
    period.start = opts.start
    period.end = opts.end
  }
  return wsSend('recap_create', {
    projectUri: opts.projectUri,
    period,
    timeZone: browserTimeZone(),
    ...(opts.signals?.length ? { signals: opts.signals } : {}),
    ...(opts.force ? { force: true } : {}),
    ...(opts.retrospect ? { retrospect: true } : {}),
  })
}

export interface RegenerateRecapOptions {
  recapId: string
  /** Synthesize-stage model override (OpenRouter slug). The eval lever. */
  model?: string
  /** synthesize re-runs the single reduce call; render/html are zero-LLM. */
  from?: 'synthesize' | 'render' | 'html'
  /** fork (default) mints a new recapId so the source survives for comparison. */
  mode?: 'fork' | 'in-place'
}

/** Send recap_regenerate over the dashboard WS. The broker replies
 *  recap_regenerated with the new fork's recapId. Returns whether the send was
 *  attempted (false only when the WS is not OPEN). */
export function regenerateRecap(opts: RegenerateRecapOptions): boolean {
  return wsSend('recap_regenerate', {
    recapId: opts.recapId,
    from: opts.from ?? 'synthesize',
    mode: opts.mode ?? 'fork',
    ...(opts.model ? { model: opts.model } : {}),
  })
}

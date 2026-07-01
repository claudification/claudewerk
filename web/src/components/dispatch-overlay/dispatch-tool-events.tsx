import { cn } from '@/lib/utils'
import { DISPATCH_MODELS, type DispatchToolEvent } from './dispatch-models'

// react-doctor:only-export-components -- modelLabel is a tiny helper co-located
// with ToolEvents; both are consumed together by dispatch-tail.
/** Friendly label for a model slug (falls back to the slug tail). */
export function modelLabel(slug?: string): string | undefined {
  if (!slug) return undefined
  return DISPATCH_MODELS.find(m => m.slug === slug)?.label ?? slug.split('/').pop()
}

const GLYPH: Record<DispatchToolEvent['status'], string> = { running: '⋯', error: '✕', ok: '·' }

function ToolEventLine({ e }: { e: DispatchToolEvent }) {
  return (
    <div className="flex items-baseline gap-1.5 font-mono text-[11px] text-comment/55">
      <span className="flex-none">{GLYPH[e.status]}</span>
      <span className={cn('truncate', e.status === 'error' && 'text-destructive/60')}>{e.summary || e.name}</span>
    </div>
  )
}

/** The agent loop's gears, rendered DIMMED -- one line per tool call, marked
 *  once its result lands ("for now" raw visibility into what the dispatcher did). */
export function ToolEvents({ events }: { events: DispatchToolEvent[] | undefined }) {
  if (!events || events.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      {events.map(e => (
        <ToolEventLine key={e.callId} e={e} />
      ))}
    </div>
  )
}

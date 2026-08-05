import { wireKey } from '@shared/system-events'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import { EventBody, eventCard, rendersNothing } from './system-entry'
import { TimeStamp } from './timestamp'

// What an event MEANS lives in `@shared/system-events` (backend-agnostic); how it LOOKS lives
// in ./system-entry. This file owns only the two chrome variants: a centered standalone line,
// and the left-aligned one folded into a running assistant group.

type Entry = Record<string, unknown>

/** The card component, already bound to its entry -- or null when this is a plain line. */
function cardFor(entry: Entry, ts?: string | number): React.ReactNode | null {
  const Card = eventCard(entry)
  return Card ? <Card entry={entry} ts={ts} /> : null
}

export function SystemLine({ group, ts }: { group: DisplayGroup; ts?: string | number }) {
  const entry = group.entries[0] as Entry
  const card = cardFor(entry, ts)
  if (card) return card
  if (rendersNothing(entry)) return null

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <EventBody entry={entry} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={group.systemSubtype || wireKey(entry) || 'system'} data={entry} raw={entry} />
    </div>
  )
}

// Inline variant rendered inside an assistant group's body. Left-aligned, tighter margin,
// same content + severity as the standalone SystemLine.
export function SystemLineInline({ entry, subtype, ts }: { entry: Entry; subtype: string; ts?: string | number }) {
  const card = cardFor(entry, ts)
  if (card) return card
  if (rendersNothing(entry)) return null

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <EventBody entry={entry} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={subtype || wireKey(entry) || 'system'} data={entry} raw={entry} />
    </div>
  )
}

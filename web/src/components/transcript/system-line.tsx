import { wireKey } from '@shared/system-events'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import { EventBody, eventCard, rendersNothing } from './system-entry'
import { TimeStamp } from './timestamp'

// What an event MEANS lives in `@shared/system-events` (backend-agnostic); how it LOOKS lives
// in ./system-entry. This file owns only the two chrome variants: a centered standalone line,
// and the left-aligned one folded into a running assistant group.

type Entry = Record<string, unknown>

/**
 * The entry as the shared registry should SEE it. Some system groups are synthesized by the
 * grouper out of an entry that is not itself `type: "system"` -- hook feedback arrives as a
 * plain Claude Code user entry -- and the decision lands on the GROUP, as `systemSubtype`.
 * `describeEvent` keys off the entry's own wire key, so without re-attaching that subtype the
 * entry falls through the registry's unclaimed-kind fallback and the timeline draws a bare
 * `[user]`. The inspector below still gets the untouched raw entry.
 */
function asSystem(entry: Entry, subtype?: string): Entry {
  return subtype && entry.type !== 'system' ? { ...entry, type: 'system', subtype } : entry
}

/** The card component, already bound to its entry -- or null when this is a plain line. */
function cardFor(entry: Entry, ts?: string | number): React.ReactNode | null {
  const Card = eventCard(entry)
  return Card ? <Card entry={entry} ts={ts} /> : null
}

export function SystemLine({ group, ts }: { group: DisplayGroup; ts?: string | number }) {
  const entry = group.entries[0] as Entry
  const described = asSystem(entry, group.systemSubtype)
  const card = cardFor(described, ts)
  if (card) return card
  if (rendersNothing(described)) return null

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <EventBody entry={described} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={group.systemSubtype || wireKey(entry) || 'system'} data={entry} raw={entry} />
    </div>
  )
}

// Inline variant rendered inside an assistant group's body. Left-aligned, tighter margin,
// same content + severity as the standalone SystemLine.
export function SystemLineInline({ entry, subtype, ts }: { entry: Entry; subtype: string; ts?: string | number }) {
  const described = asSystem(entry, subtype)
  const card = cardFor(described, ts)
  if (card) return card
  if (rendersNothing(described)) return null

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <EventBody entry={described} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={subtype || wireKey(entry) || 'system'} data={entry} raw={entry} />
    </div>
  )
}

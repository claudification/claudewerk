import type { SystemEntry } from '@shared/system-events'
import { describeEvent, kindOf, visibilityOf } from '@shared/system-events'
import { BgTasksHint } from '../bg-tasks-hint'
import { AwaySummaryCard } from './cards'
import { EventIcon, severityColor } from './palette'

// The web surface over the shared event registry. Everything backend-specific lives in
// `@shared/system-events`; this file only turns a described event into DOM, and owns the two
// kinds that need React because they draw their own bordered block.

type CardProps = { entry: SystemEntry; ts?: string | number }

const CARDS: Record<string, React.ComponentType<CardProps>> = {
  recap: AwaySummaryCard,
  'bg-tasks': BgTasksHint,
}

/** The card component for an entry whose kind owns one, else null. */
export function eventCard(entry: SystemEntry): React.ComponentType<CardProps> | null {
  if (visibilityOf(entry) !== 'card') return null
  const kind = kindOf(entry)
  return kind ? (CARDS[kind] ?? null) : null
}

/** The text + icon (+ link) of an event line, or null when it renders nothing. */
export function EventBody({ entry }: { entry: SystemEntry }) {
  const line = describeEvent(entry)
  if (!line) return null
  const color = severityColor(line.severity)
  const text = line.href ? (
    <a
      href={line.href}
      target="_blank"
      rel="noreferrer noopener"
      className={`${color} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
    >
      {line.text}
    </a>
  ) : (
    <span className={color}>{line.text}</span>
  )
  if (!line.icon) return text
  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <EventIcon name={line.icon} />
      {text}
    </span>
  )
}

/** True when this entry produces no DOM at all (hidden kind, or an empty describer result). */
export function rendersNothing(entry: SystemEntry): boolean {
  return visibilityOf(entry) !== 'card' && describeEvent(entry) === null
}

// No re-exports of the shared registry: callers import from `@shared/system-events`
// directly, so there is exactly one path to it and no web-shaped shadow of the vocabulary.

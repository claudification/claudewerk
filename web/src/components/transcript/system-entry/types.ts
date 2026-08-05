import type { ReactNode } from 'react'

/** A one-line system entry: text + tailwind color, optionally an icon and a link. */
export interface TextResult {
  kind: 'text'
  text: string
  color: string
  /** Leading glyph rendered before the text by SystemLine / SystemLineInline. */
  icon?: ReactNode
  /** When set, the text renders as an external link (target=_blank, noreferrer). */
  href?: string
}

/** A system entry that renders its own bordered card instead of a line. */
export interface JsxResult {
  kind: 'jsx'
  node: ReactNode
}

export type SystemEntryResult = TextResult | JsxResult

/** A raw CC `type: "system"` transcript entry, shape known only per-subtype. */
export type SystemEntry = Record<string, unknown>

/**
 * Formats ONE CC system subtype. Returns null when the entry renders nothing.
 *
 * Every describer must survive a partial entry: CC ships new fields (and new
 * enum members) on the wire ahead of our schema, and older CLIs omit fields
 * newer ones always send. Read defensively, never throw.
 */
export type SystemDescriber = (entry: SystemEntry, ts?: string | number) => SystemEntryResult | null

/** Reads a string field, collapsing undefined/non-string to ''. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Reads a finite number field, collapsing anything else to undefined. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** First non-empty line of a multi-line payload (hook stderr, feedback text). */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** Caps a one-line summary so a runaway payload cannot blow up the timeline. */
export function clamp(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * Point-in-time fork: the boundary the transcript picked, and the copy that
 * describes what carrying each side actually means.
 *
 * The seed is captured at RIGHT-CLICK time from the entry under the cursor and
 * carried into the dialog unchanged. Direction and inclusivity are chosen in the
 * dialog, not the menu -- one menu item, one place to decide.
 */

export type ForkDirection = 'before' | 'after'

/** What the transcript hands the dialog when you fork from a specific message. */
export interface ForkPointSeed {
  /** CC uuid, when the entry has a real one. Absent for panel-only rows. */
  uuid?: string
  /** ISO timestamp. The fallback the sentinel resolves when the uuid misses. */
  timestamp?: string
  /** Who said it, for the preview label. */
  role: 'user' | 'assistant'
  /** First PREVIEW_CHARS of the message, already flattened to plain text. */
  preview: string
}

/** The wire shape. Mirrors `ForkPoint` in src/shared/protocol.ts. */
export interface ForkPointRequest {
  uuid?: string
  timestamp?: string
  direction: ForkDirection
  inclusive: boolean
  summarizeDropped?: boolean
}

export const PREVIEW_CHARS = 300

export interface ForkDirectionSpec {
  value: ForkDirection
  label: string
  hint: string
}

/**
 * Deliberately explicit about which side SURVIVES. "Fork from here" reads as
 * both "starting at this message" and "everything leading to this message"
 * depending on who is reading, and picking the wrong one silently throws away
 * the half you wanted.
 */
export const FORK_DIRECTIONS: Record<ForkDirection, ForkDirectionSpec> = {
  before: {
    value: 'before',
    label: 'Everything BEFORE',
    hint: 'Carry the history leading up to this point and drop what came after. Use it to take the same context somewhere else, or to redo this turn differently.',
  },
  after: {
    value: 'after',
    label: 'Everything AFTER',
    hint: 'Carry this point onward and drop the older history. Use it to escape an exhausted context while keeping the work you are actually in the middle of.',
  },
}

export const FORK_DIRECTION_ORDER: ForkDirection[] = ['before', 'after']

/** Collapse whitespace and clip, so a 40-line paste stays a one-glance label. */
export function previewText(raw: string, limit = PREVIEW_CHARS): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}...` : flat
}

/**
 * Build the wire boundary, or undefined when there is nothing to cut at.
 *
 * A seed with neither uuid nor timestamp cannot locate anything, and the broker
 * rejects it -- returning undefined here forks from HEAD instead, which is the
 * honest fallback for an entry the panel could not identify.
 */
export function toForkPointRequest(
  seed: ForkPointSeed | undefined,
  opts: { direction: ForkDirection; inclusive: boolean; summarizeDropped: boolean },
): ForkPointRequest | undefined {
  if (!seed || (!seed.uuid && !seed.timestamp)) return undefined
  return {
    uuid: seed.uuid,
    timestamp: seed.timestamp,
    direction: opts.direction,
    inclusive: opts.inclusive,
    // Only meaningful when the dropped slice is the OLD history. Sending it for
    // `before` would summarize the future the fork exists to redo.
    summarizeDropped: opts.direction === 'after' && opts.summarizeDropped,
  }
}

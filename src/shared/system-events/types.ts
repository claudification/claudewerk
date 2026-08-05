/**
 * The agnostic transcript-event vocabulary: what a lifecycle line MEANS, with no backend
 * words in it. Claude Code says `system/api_error`, the chat-api backend says
 * `system/chat_api_error`, ACP says its own thing -- all three are the kind `api-error`, and
 * the renderer only ever learns the kind.
 *
 * Pure by construction: no React, no Excalidraw, no Claude Code. A describer returns text +
 * a SEVERITY + an icon NAME; mapping severity to a color and a name to a component is the
 * surface's job, so a terminal, a push notification or a recap can reuse this file as-is.
 */

/** What the line means, not what color it is. The surface owns the palette. */
export type Severity = 'error' | 'warn' | 'notice' | 'info' | 'muted'

/**
 * How the event reaches the transcript.
 * - `line`   -- a one-line entry in the timeline
 * - `card`   -- its own bordered block, drawn by a surface-specific component
 * - `hidden` -- persisted and inspectable, but never drawn (heartbeats, snapshots, metadata)
 */
export type Visibility = 'line' | 'card' | 'hidden'

/** Icons by NAME. The web surface maps these to lucide components; a TTY can ignore them. */
export type IconName =
  | 'commit'
  | 'push'
  | 'merge'
  | 'rebase'
  | 'pull-request'
  | 'worktree'
  | 'folder'
  | 'shield'
  | 'power'

/** A rendered event line. `href` makes the text a link; `icon` is advisory. */
export interface EventLine {
  text: string
  severity: Severity
  icon?: IconName
  href?: string
}

/** A raw transcript entry. Shape is known only per-kind, so every read is defensive. */
export type SystemEntry = Record<string, unknown>

/**
 * Formats ONE kind. Returns null when this particular entry renders nothing (an empty
 * command output, a hook that succeeded).
 *
 * Every describer must survive a partial entry: backends ship new fields and new enum members
 * on the wire ahead of our schema, and older ones omit fields newer ones always send. Read
 * defensively, never throw.
 */
export type Describer = (entry: SystemEntry) => EventLine | null

/** Reads a string field, collapsing undefined/non-string to ''. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Reads a finite number field, collapsing anything else to undefined. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Reads a nested object field as a bag, never null/undefined. */
export function bag(value: unknown): SystemEntry {
  return value && typeof value === 'object' ? (value as SystemEntry) : {}
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

/** The last path segment -- a worktree/branch name out of an absolute path. */
export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

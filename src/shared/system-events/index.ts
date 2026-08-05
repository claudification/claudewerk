/**
 * The transcript-event registry. One kind -> one describer -> one line, whichever backend
 * dialect the entry arrived in (see sources.ts for the translation).
 *
 * Three questions a surface asks:
 *   visibilityOf(entry)  -- do I draw this at all, and as a line or a card?
 *   describeEvent(entry) -- what does the line say?
 *   kindOf(entry)        -- which component owns the card?
 *
 * An entry no dialect claims is NOT dropped: it renders its `content`, or `[wireKey]`, so a
 * subtype shipped ahead of us still shows up in the timeline with its payload one click away.
 * That fallback line IS the signal to come add a row here.
 */
import { CAPABILITY_DESCRIBERS } from './describe-capability'
import { CONVERSATION_DESCRIBERS } from './describe-conversation'
import { REQUEST_DESCRIBERS } from './describe-request'
import { SESSION_DESCRIBERS } from './describe-session'
import { TASK_DESCRIBERS } from './describe-tasks'
import { VCS_DESCRIBERS } from './describe-vcs'
import { kindOf, wireKey } from './sources'
import type { Describer, EventLine, SystemEntry, Visibility } from './types'
import { str } from './types'

const DESCRIBERS: Record<string, Describer> = {
  ...REQUEST_DESCRIBERS,
  ...CONVERSATION_DESCRIBERS,
  ...CAPABILITY_DESCRIBERS,
  ...TASK_DESCRIBERS,
  ...VCS_DESCRIBERS,
  ...SESSION_DESCRIBERS,
}

/**
 * Kinds that are persisted and inspectable but never drawn. Each one is here for a reason,
 * and "it is chatty" alone is not one -- these carry no timeline meaning at all:
 *
 * - `heartbeat` (213k rows), `snapshot`, `post-turn-summary` -- per-request bookkeeping.
 * - `thinking-tokens` (1.9k rows) -- a running token ESTIMATE, digested frame by frame. The
 *   thinking pill already shows it; as a line it was 1.9k gray `[thinking_tokens]` tokens.
 * - `commands-list` -- a fire-and-forget push of the whole slash-command list after skills
 *   are discovered. A capability update, not an event.
 * - `task-started` / `hook-started` -- the OPENING frame of a bracketed triple. The
 *   transcript keeps one line per hook (`hook-ran`) and lets the tasks panel own task
 *   lifecycle; without this a single PostToolUse hook drew three lines.
 * - `task-status` (24k rows) / `task-progress` (47k rows) -- the tasks panel owns these, and
 *   the timeline's task lines come from <task-notification> blocks in message text instead.
 * - `task-summary` -- an ephemeral terminal-title classifier, not a transcript line.
 * - `session-init`, `title-set`, `agent-named`, `agent-setting`, `attachment`, `prompt-echo`
 *   -- conversation metadata the panel renders in its own chrome (header, title, attachments).
 */
const HIDDEN_KINDS = new Set([
  'heartbeat',
  'snapshot',
  'post-turn-summary',
  'task-status',
  'task-progress',
  'thinking-tokens',
  'commands-list',
  'task-started',
  'hook-started',
  'task-summary',
  'session-init',
  'title-set',
  'agent-named',
  'agent-setting',
  'attachment',
  'prompt-echo',
])

/** Kinds that own a bordered block instead of a line; the surface supplies the component. */
const CARD_KINDS = new Set(['recap', 'bg-tasks'])

/** Do we draw this entry, and how? */
export function visibilityOf(entry: SystemEntry): Visibility {
  const kind = kindOf(entry)
  if (kind && HIDDEN_KINDS.has(kind)) return 'hidden'
  if (kind && CARD_KINDS.has(kind)) return 'card'
  return 'line'
}

/** True for entries that carry no timeline meaning -- never drawn, never budgeted for. */
export function isHiddenEvent(entry: SystemEntry): boolean {
  return visibilityOf(entry) === 'hidden'
}

/**
 * The line for an entry, or null when this particular one renders nothing. Callers that
 * already know the kind owns a card should check `visibilityOf` first.
 */
export function describeEvent(entry: SystemEntry): EventLine | null {
  const kind = kindOf(entry)
  if (kind && HIDDEN_KINDS.has(kind)) return null
  const describer = kind ? DESCRIBERS[kind] : undefined
  if (describer) return describer(entry)
  return { text: str(entry.content) || `[${wireKey(entry)}]`, severity: 'muted' }
}

/** Every kind that has a describer -- the tests walk this against the alias table. */
export const DESCRIBED_KINDS: string[] = Object.keys(DESCRIBERS)
export { kindOf, WIRE_KEYS, wireKey } from './sources'
export type { EventLine, IconName, Severity, SystemEntry, Visibility } from './types'
export { CARD_KINDS, HIDDEN_KINDS }

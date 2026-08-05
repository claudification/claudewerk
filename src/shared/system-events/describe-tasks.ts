/** The task/hook lane. */
import type { Describer, SystemEntry } from './types'
import { bag, clamp, firstLine, num, str } from './types'

// `task-status` and `task-progress` have no describer on purpose: they are hidden kinds. The
// tasks panel owns task lifecycle, and at 24k/47k rows in the store they would bury the
// timeline. The transcript's task lines come from the <task-notification> blocks inside
// message text, a different path entirely.

/**
 * `task-updated` -- newer Claude Code carries the change under `patch`; older builds put the
 * same fields at the top level. Read both, so neither shape renders as an empty line.
 */
const taskUpdated: Describer = entry => {
  const patch = bag(entry.patch)
  const field = (key: string): string => str(patch[key]) || str(entry[key])
  const err = field('error')
  if (err) return { text: `Task error: ${err}`, severity: 'error' }
  if (entry.is_backgrounded) return { text: 'Task backgrounded', severity: 'muted' }
  const label = field('description') || str(patch.status)
  return label ? { text: `Task: ${label}`, severity: 'muted' } : null
}

const hookRan: Describer = entry => {
  const name = str(entry.hook_name) || 'hook'
  const event = str(entry.hook_event)
  return { text: `Hook ${name}${event ? ` (${event})` : ''}`, severity: 'muted' }
}

/**
 * `hook-failed` -- the terminal frame of the started/progress/response triple a hook emits.
 * A successful hook is pure noise (`hook-ran` already drew a line for it), so only a
 * non-success outcome renders, carrying whatever the hook actually complained about.
 */
const hookFailed: Describer = entry => {
  const outcome = str(entry.outcome)
  if (outcome === 'success' || !outcome) return null
  const code = num(entry.exit_code)
  const detail = firstLine(str(entry.stderr) || str(entry.output))
  const head = `Hook ${str(entry.hook_name) || 'hook'} ${outcome}${code === undefined ? '' : ` (exit ${code})`}`
  return {
    text: clamp(detail ? `${head}: ${detail}` : head),
    severity: outcome === 'cancelled' ? 'warn' : 'error',
  }
}

/** Text blocks of a message payload, flattened -- hook feedback arrives as a user entry. */
function messageText(entry: SystemEntry): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return str(entry.content)
  return content.map(block => (block as { text?: string })?.text ?? '').join('')
}

/**
 * `hook-feedback` is synthesized by the grouper from a USER entry carrying the hook reason at
 * message.content -- not a real system entry, so its `content` is empty. Summarize the
 * "<Event> hook feedback:\n<reason>" payload onto one line; the full text stays one click
 * away in the JSON inspector.
 */
const hookFeedback: Describer = entry => {
  const lines = messageText(entry)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const header = lines[0]?.replace(/\s*feedback:?\s*$/i, '') || 'Hook'
  const reason = lines.slice(1).join(' ')
  return { text: clamp(reason ? `${header}: ${reason}` : header), severity: 'warn' }
}

export const TASK_DESCRIBERS: Record<string, Describer> = {
  'task-updated': taskUpdated,
  'hook-ran': hookRan,
  'hook-failed': hookFailed,
  'hook-feedback': hookFeedback,
}

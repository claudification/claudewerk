import type { SystemDescriber, SystemEntry } from './types'
import { clamp, firstLine, num, str } from './types'

const TASK_STATUS_COLORS: Record<string, string> = {
  completed: 'text-emerald-400',
  failed: 'text-red-400',
}

const taskNotification: SystemDescriber = entry => {
  const status = str(entry.status)
  const summary = str(entry.summary)
  return {
    kind: 'text',
    text: `Task ${status}${summary ? `: ${summary}` : ''}`,
    color: TASK_STATUS_COLORS[status] || 'text-amber-400',
  }
}

const taskProgress: SystemDescriber = entry => {
  const desc = str(entry.description)
  const tokens = num((entry.usage as SystemEntry | undefined)?.total_tokens)
  return { kind: 'text', text: `${desc}${tokens ? ` (${tokens} tokens)` : ''}`, color: 'text-muted-foreground/70' }
}

/**
 * `system/task_updated` -- CC 2.1.221 carries the change under `patch`; older
 * CLIs put the same fields at the top level. Read both so neither shape renders
 * as an empty line.
 */
const taskUpdated: SystemDescriber = entry => {
  const patch = (entry.patch || {}) as SystemEntry
  const field = (key: string) => str(patch[key]) || str(entry[key])
  const err = field('error')
  if (err) return { kind: 'text', text: `Task error: ${err}`, color: 'text-red-400' }
  if (entry.is_backgrounded) return { kind: 'text', text: 'Task backgrounded', color: 'text-muted-foreground/70' }
  const label = field('description') || str(patch.status)
  if (!label) return null
  return { kind: 'text', text: `Task: ${label}`, color: 'text-muted-foreground/70' }
}

const hookProgress: SystemDescriber = entry => {
  const name = str(entry.hook_name) || 'hook'
  const event = str(entry.hook_event)
  return { kind: 'text', text: `Hook ${name}${event ? ` (${event})` : ''}`, color: 'text-muted-foreground/50' }
}

/**
 * `system/hook_response` -- the terminal frame of the started/progress/response
 * triple CC emits per hook. A successful hook is pure noise (hook_progress
 * already drew a line for it), so only a non-success outcome renders, with
 * whatever the hook actually complained about.
 */
const hookResponse: SystemDescriber = entry => {
  const outcome = str(entry.outcome)
  if (outcome === 'success' || !outcome) return null
  const code = num(entry.exit_code)
  const detail = firstLine(str(entry.stderr) || str(entry.output))
  const head = `Hook ${str(entry.hook_name) || 'hook'} ${outcome}${code === undefined ? '' : ` (exit ${code})`}`
  return {
    kind: 'text',
    text: clamp(detail ? `${head}: ${detail}` : head),
    color: outcome === 'cancelled' ? 'text-amber-400/70' : 'text-red-400',
  }
}

/**
 * `hook_feedback` is synthesized by the grouper from a CC USER entry carrying
 * the hook reason at message.content (a text-block array, occasionally a bare
 * string) -- not a real system entry, so `content` is empty. Summarize the
 * "<Event> hook feedback:\n<reason>" payload onto one line; the JsonInspector
 * carries the full text.
 */
const hookFeedback: SystemDescriber = entry => {
  const msg = (entry.message as { content?: unknown } | undefined)?.content
  const raw =
    typeof msg === 'string'
      ? msg
      : Array.isArray(msg)
        ? msg.map(b => (b as { text?: string })?.text ?? '').join('')
        : str(entry.content)
  const lines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const header = lines[0]?.replace(/\s*feedback:?\s*$/i, '') || 'Hook'
  const reason = lines.slice(1).join(' ')
  return {
    kind: 'text',
    text: clamp(reason ? `${header}: ${reason}` : header),
    color: 'text-amber-400/70',
  }
}

const pluginInstall: SystemDescriber = entry => {
  const status = str(entry.status)
  const name = str(entry.name)
  const err = str(entry.error)
  return {
    kind: 'text',
    text: `Plugin install${name ? ` ${name}` : ''}: ${status}${err ? ` -- ${err}` : ''}`,
    color: status === 'failed' ? 'text-red-400' : 'text-muted-foreground/70',
  }
}

export const TASK_DESCRIBERS: Record<string, SystemDescriber> = {
  task_notification: taskNotification,
  task_progress: taskProgress,
  task_updated: taskUpdated,
  // CC's ephemeral terminal-title classifier, not a transcript line (and it
  // does not fire in headless at all). Belt-and-suspenders: never render one
  // even if it slips past the noise filter.
  task_summary: () => null,
  hook_progress: hookProgress,
  hook_response: hookResponse,
  hook_feedback: hookFeedback,
  plugin_install: pluginInstall,
  elicitation_complete: entry => ({
    kind: 'text',
    text: `Elicitation complete${entry.mcp_server_name ? ` (${str(entry.mcp_server_name)})` : ''}`,
    color: 'text-muted-foreground/70',
  }),
}

import { formatDuration } from '../group-view-types'
import type { SystemDescriber } from './types'
import { num, str } from './types'

const COMMAND_TAG_RE = /<\/?(?:local-command-stdout|command-name|command-message|command-args|local-command-caveat)>/g

const localCommand: SystemDescriber = entry => {
  const stripped = str(entry.content).replace(COMMAND_TAG_RE, '').trim()
  if (!stripped) return null
  let color = 'text-muted-foreground'
  if (stripped.startsWith('Unknown skill') || stripped.startsWith('Error') || stripped.startsWith('Failed'))
    color = 'text-red-400'
  if (stripped.startsWith('Conversation renamed to:')) color = 'text-cyan-400/70'
  return { kind: 'text', text: stripped, color }
}

/** CC's own render levels for `informational`; anything unknown reads as info. */
const INFORMATIONAL_COLORS: Record<string, string> = {
  info: 'text-cyan-400/70',
  notice: 'text-cyan-400/70',
  suggestion: 'text-muted-foreground',
  warning: 'text-amber-400',
}

const informational: SystemDescriber = entry => ({
  kind: 'text',
  text: str(entry.content),
  color: INFORMATIONAL_COLORS[str(entry.level)] || 'text-cyan-400/70',
})

const turnDuration: SystemDescriber = entry => {
  const dMs = num(entry.durationMs) ?? num(entry.duration_ms) ?? 0
  const dApiMs = num(entry.durationApiMs) ?? num(entry.duration_api_ms)
  const msgCount = num(entry.messageCount)
  return {
    kind: 'text',
    text: dMs
      ? `Turn: ${formatDuration(dMs / 1000)}${dApiMs ? ` (API: ${formatDuration(dApiMs / 1000)})` : ''}${msgCount ? ` -- ${msgCount} messages` : ''}`
      : 'Turn ended',
    color: 'text-muted-foreground/50',
  }
}

const stopHookSummary: SystemDescriber = entry => {
  const reason = str(entry.stopReason) || str(entry.stop_reason) || 'end_turn'
  const numTurns = num(entry.numTurns) ?? num(entry.num_turns)
  const parts = [`Stop: ${reason}`]
  if (numTurns) parts.push(`${numTurns} turns`)
  return { kind: 'text', text: parts.join(' -- '), color: 'text-muted-foreground/50' }
}

const scheduledTaskFire: SystemDescriber = entry => {
  const content = str(entry.content)
  return {
    kind: 'text',
    text: content
      ? `Scheduled: ${content.length > 80 ? `${content.slice(0, 80)}...` : content}`
      : 'Scheduled task fired',
    color: 'text-amber-400/70',
  }
}

const notification: SystemDescriber = entry => {
  const text = str(entry.text) || str(entry.content)
  if (!text) return null
  return { kind: 'text', text, color: entry.priority === 'high' ? 'text-amber-400' : 'text-cyan-400/70' }
}

const memoryRecall: SystemDescriber = entry => {
  const memories = entry.memories
  const mode = str(entry.mode)
  const n = Array.isArray(memories) ? memories.length : 0
  return {
    kind: 'text',
    text: `Recalled ${n} ${n === 1 ? 'memory' : 'memories'}${mode ? ` (${mode})` : ''}`,
    color: 'text-cyan-400/70',
  }
}

const filesPersisted: SystemDescriber = entry => {
  const n = Array.isArray(entry.files) ? entry.files.length : 0
  const f = Array.isArray(entry.failed) ? entry.failed.length : 0
  return {
    kind: 'text',
    text: `Saved ${n} ${n === 1 ? 'file' : 'files'}${f ? ` (${f} failed)` : ''}`,
    color: f ? 'text-red-400/80' : 'text-cyan-400/70',
  }
}

/**
 * `system/worker_shutting_down` -- the host CLI tore the worker down on purpose
 * and said why. CC's schema warns this lands in the DURABLE event stream, so a
 * resumed conversation replays historical instances mid-transcript: it is a
 * timeline line, never a live "host is dead" verdict. `reason` is a short
 * snake_case constant set by the CLI (not user input), so it is safe to show raw.
 */
const workerShuttingDown: SystemDescriber = entry => {
  const reason = str(entry.reason)
  return {
    kind: 'text',
    text: `Worker shutting down${reason ? `: ${reason}` : ''}`,
    color: 'text-amber-400/70',
  }
}

export const CORE_DESCRIBERS: Record<string, SystemDescriber> = {
  local_command: localCommand,
  // Output of a local slash command (/voice, /usage) -- CC renders it as
  // assistant-style text, so it keeps the neutral foreground color.
  local_command_output: entry => {
    const content = str(entry.content).trim()
    return content ? { kind: 'text', text: content, color: 'text-muted-foreground' } : null
  },
  informational,
  compact_boundary: () => ({ kind: 'text', text: 'Context compacted', color: 'text-purple-400/70' }),
  session_state_changed: entry => ({
    kind: 'text',
    text: `Conversation: ${str(entry.state)}`,
    color: 'text-muted-foreground/70',
  }),
  turn_duration: turnDuration,
  stop_hook_summary: stopHookSummary,
  scheduled_task_fire: scheduledTaskFire,
  notification,
  memory_saved: () => ({ kind: 'text', text: 'Memory saved', color: 'text-cyan-400/70' }),
  memory_recall: memoryRecall,
  agents_killed: () => ({ kind: 'text', text: 'Background agents stopped', color: 'text-red-400/70' }),
  files_persisted: filesPersisted,
  permission_retry: entry => ({
    kind: 'text',
    text: `Allowed: ${(entry.commands as string[])?.join(', ') || str(entry.content)}`,
    color: 'text-green-400/70',
  }),
  permission_denied: entry => ({
    kind: 'text',
    text: `Permission denied: ${str(entry.tool_name) || 'tool'}${entry.agent_id ? ' (subagent)' : ''}`,
    color: 'text-red-400',
  }),
  worker_shutting_down: workerShuttingDown,
}

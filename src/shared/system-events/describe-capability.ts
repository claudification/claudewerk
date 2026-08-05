/** The capability/state lane: memory, files, permissions, plugins, host teardown. */
import type { Describer } from './types'
import { str } from './types'

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

const memoryRecall: Describer = entry => {
  const n = count(entry.memories)
  const mode = str(entry.mode)
  return {
    text: `Recalled ${n} ${n === 1 ? 'memory' : 'memories'}${mode ? ` (${mode})` : ''}`,
    severity: 'info',
  }
}

const filesSaved: Describer = entry => {
  const n = count(entry.files)
  const failed = count(entry.failed)
  return {
    text: `Saved ${n} ${n === 1 ? 'file' : 'files'}${failed ? ` (${failed} failed)` : ''}`,
    severity: failed ? 'error' : 'info',
  }
}

const permissionDenied: Describer = entry => {
  const tool = str(entry.tool_name) || 'tool'
  const why = str(entry.decision_reason) || str(entry.decision_reason_type)
  const scope = entry.agent_id ? ' (subagent)' : ''
  return { text: `Permission denied: ${tool}${scope}${why ? ` -- ${why}` : ''}`, severity: 'error' }
}

const pluginInstall: Describer = entry => {
  const status = str(entry.status)
  const name = str(entry.name)
  const err = str(entry.error)
  return {
    text: `Plugin install${name ? ` ${name}` : ''}: ${status}${err ? ` -- ${err}` : ''}`,
    severity: status === 'failed' ? 'error' : 'muted',
  }
}

/**
 * `worker-shutdown` -- the host tore the worker down on purpose and said why. This lands in
 * the DURABLE event stream, so a resumed conversation replays historical instances
 * mid-transcript: it is a timeline line, never a live "the host is dead" verdict.
 * `reason` is a short snake_case constant set by the host (not user input), safe to show raw.
 */
const workerShutdown: Describer = entry => {
  const reason = str(entry.reason)
  return { text: `Worker shutting down${reason ? `: ${reason}` : ''}`, severity: 'warn', icon: 'power' }
}

export const CAPABILITY_DESCRIBERS: Record<string, Describer> = {
  'memory-saved': () => ({ text: 'Memory saved', severity: 'info' }),
  'memory-recall': memoryRecall,
  'files-saved': filesSaved,
  'agents-killed': () => ({ text: 'Background agents stopped', severity: 'error' }),
  'permission-allowed': entry => ({
    text: `Allowed: ${(entry.commands as string[])?.join(', ') || str(entry.content)}`,
    severity: 'info',
    icon: 'shield',
  }),
  'permission-denied': permissionDenied,
  'plugin-install': pluginInstall,
  'elicitation-done': entry => ({
    text: `Elicitation complete${entry.mcp_server_name ? ` (${str(entry.mcp_server_name)})` : ''}`,
    severity: 'muted',
  }),
  'worker-shutdown': workerShutdown,
}

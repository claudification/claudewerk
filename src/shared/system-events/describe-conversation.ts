/** The conversation lane: turns, commands, compaction, notices. */
import type { Describer } from './types'
import { clamp, firstLine, messageText, num, str } from './types'

const COMMAND_TAG_RE = /<\/?(?:local-command-stdout|command-name|command-message|command-args|local-command-caveat)>/g

const commandInput: Describer = entry => {
  const stripped = str(entry.content).replace(COMMAND_TAG_RE, '').trim()
  if (!stripped) return null
  if (stripped.startsWith('Unknown skill') || stripped.startsWith('Error') || stripped.startsWith('Failed'))
    return { text: stripped, severity: 'error' }
  if (stripped.startsWith('Conversation renamed to:')) return { text: stripped, severity: 'info' }
  return { text: stripped, severity: 'muted' }
}

/** The backend's own render levels; anything unrecognized reads as info. */
const INFO_SEVERITY: Record<string, 'info' | 'warn' | 'muted'> = {
  info: 'info',
  notice: 'info',
  suggestion: 'muted',
  warning: 'warn',
}

/** Duration in whole seconds/minutes -- the transcript never needs millisecond precision. */
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${mins}m ${rest}s` : `${mins}m`
}

const turnDuration: Describer = entry => {
  const ms = num(entry.durationMs) ?? num(entry.duration_ms) ?? 0
  const apiMs = num(entry.durationApiMs) ?? num(entry.duration_api_ms)
  const messages = num(entry.messageCount)
  if (!ms) return { text: 'Turn ended', severity: 'muted' }
  const api = apiMs ? ` (API: ${duration(apiMs / 1000)})` : ''
  const count = messages ? ` -- ${messages} messages` : ''
  return { text: `Turn: ${duration(ms / 1000)}${api}${count}`, severity: 'muted' }
}

const turnStop: Describer = entry => {
  const reason = str(entry.stopReason) || str(entry.stop_reason) || 'end_turn'
  const turns = num(entry.numTurns) ?? num(entry.num_turns)
  return { text: `Stop: ${reason}${turns ? ` -- ${turns} turns` : ''}`, severity: 'muted' }
}

const scheduledFire: Describer = entry => {
  const content = str(entry.content)
  return {
    text: content ? `Scheduled: ${clamp(content, 80)}` : 'Scheduled task fired',
    severity: 'warn',
  }
}

const notification: Describer = entry => {
  const text = str(entry.text) || str(entry.content)
  if (!text) return null
  const priority = str(entry.priority)
  return { text, severity: priority === 'high' || priority === 'immediate' ? 'warn' : 'info' }
}

/**
 * `harness-meta` -- Claude Code's own prose, injected as a user entry flagged
 * `isMeta` and synthesized into a system group by the grouper. A commit nudge, a
 * resume caveat, a malformed-tool-call retry: addressed to the model, never to the
 * reader. It earns one muted line so the timeline stays honest about who spoke,
 * with the full text one click away in the inspector -- and it must never wear the
 * user's bubble, which is what it did before.
 */
const harnessMeta: Describer = entry => {
  const text = firstLine(messageText(entry))
    .replace(/^\[|\]$/g, '')
    .trim()
  return text ? { text: clamp(text, 120), severity: 'muted' } : null
}

export const CONVERSATION_DESCRIBERS: Record<string, Describer> = {
  'harness-meta': harnessMeta,
  'command-input': commandInput,
  // Output of a local slash command (/voice, /usage): the backend renders it as
  // assistant-style text, so it keeps the neutral tone.
  'command-output': entry => {
    const content = str(entry.content).trim()
    return content ? { text: content, severity: 'muted' } : null
  },
  info: entry => ({ text: str(entry.content), severity: INFO_SEVERITY[str(entry.level)] ?? 'info' }),
  notification,
  compacted: () => ({ text: 'Context compacted', severity: 'notice' }),
  'conversation-state': entry => ({ text: `Conversation: ${str(entry.state)}`, severity: 'muted' }),
  'turn-duration': turnDuration,
  'turn-stop': turnStop,
  'scheduled-fire': scheduledFire,
  // Rendered thinking text arrives as its own system entry on some transports; the transcript
  // already has a thinking pill for it, so this only shows when it carries text of its own.
  'thinking-text': entry => {
    const content = str(entry.content).trim()
    return content ? { text: clamp(content), severity: 'muted' } : null
  },
}

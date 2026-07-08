import { formatResetIn } from '@shared/format-reset-time'
import { parseRecapContent } from '@shared/recap'
import { formatRateBucketName } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { BgTasksHint } from './bg-tasks-hint'
import { formatDuration } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { TimeStamp } from './timestamp'

interface TextResult {
  kind: 'text'
  text: string
  color: string
}

interface JsxResult {
  kind: 'jsx'
  node: React.ReactNode
}

// Map a system entry to either a {text,color} pair or bespoke JSX
// (away_summary). Shared by the standalone SystemLine (its own group,
// centered) and the inline variant (rendered inside an assistant group,
// left-aligned). Returns null for subtypes that produce no visible content.
//
// One switch arm per CC system subtype; high cyclomatic complexity is
// inherent to the data shape and splitting would just spread the
// per-subtype formatting across multiple functions for no readability win.
// fallow-ignore-next-line complexity
function describeSystemEntry(
  sub: string,
  entry: Record<string, unknown>,
  ts?: string | number,
): TextResult | JsxResult | null {
  const content = (entry.content as string) || ''

  switch (sub) {
    case 'local_command': {
      const stripped = content
        .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|local-command-caveat)>/g, '')
        .trim()
      if (!stripped) return null
      let color = 'text-muted-foreground'
      if (stripped.startsWith('Unknown skill') || stripped.startsWith('Error') || stripped.startsWith('Failed'))
        color = 'text-red-400'
      if (stripped.startsWith('Conversation renamed to:')) color = 'text-cyan-400/70'
      return { kind: 'text', text: stripped, color }
    }
    case 'api_retry':
      return {
        kind: 'text',
        text: `API retry ${entry.attempt}/${entry.max_retries} (${entry.error_status || 'timeout'}) - retrying in ${Math.ceil((entry.retry_delay_ms as number) / 1000)}s`,
        color: 'text-amber-400',
      }
    case 'rate_limit': {
      const retryMs = entry.retryAfterMs as number | undefined
      const resetsAt = (entry.resetsAt as number | undefined) ?? undefined
      const isNotice = (entry.isNotice as boolean | undefined) ?? retryMs === undefined
      const info = (entry.raw as Record<string, unknown>)?.rate_limit_info as Record<string, unknown> | undefined
      const limitType = info?.rateLimitType as string | undefined
      const formattedType = formatRateBucketName(limitType)
      const resetTail = formatResetIn(resetsAt)
      const tail = resetTail ? ` -- ${resetTail}` : ''
      return {
        kind: 'text',
        text: isNotice ? `Rate limit notice (${formattedType})${tail}` : `Rate limited (${formattedType})${tail}`,
        color: isNotice ? 'text-amber-400/50' : 'text-amber-400/80',
      }
    }
    case 'informational':
      return { kind: 'text', text: content, color: 'text-cyan-400/70' }
    case 'compact_boundary':
      return { kind: 'text', text: 'Context compacted', color: 'text-purple-400/70' }
    case 'session_state_changed':
      return { kind: 'text', text: `Conversation: ${entry.state}`, color: 'text-muted-foreground/70' }
    case 'task_notification': {
      const status = entry.status as string
      const summary = entry.summary as string
      return {
        kind: 'text',
        text: `Task ${status}${summary ? `: ${summary}` : ''}`,
        color: status === 'completed' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : 'text-amber-400',
      }
    }
    case 'task_progress': {
      const desc = (entry.description as string) || ''
      const tokens = (entry.usage as Record<string, unknown>)?.total_tokens
      return {
        kind: 'text',
        text: `${desc}${tokens ? ` (${tokens} tokens)` : ''}`,
        color: 'text-muted-foreground/70',
      }
    }
    case 'turn_duration': {
      const dMs = (entry.durationMs as number) || (entry.duration_ms as number) || 0
      const dApiMs = (entry.durationApiMs as number) || (entry.duration_api_ms as number)
      const msgCount = entry.messageCount as number
      return {
        kind: 'text',
        text: dMs
          ? `Turn: ${formatDuration(dMs / 1000)}${dApiMs ? ` (API: ${formatDuration(dApiMs / 1000)})` : ''}${msgCount ? ` -- ${msgCount} messages` : ''}`
          : 'Turn ended',
        color: 'text-muted-foreground/50',
      }
    }
    case 'memory_saved':
      return { kind: 'text', text: 'Memory saved', color: 'text-cyan-400/70' }
    case 'agents_killed':
      return { kind: 'text', text: 'Background agents stopped', color: 'text-red-400/70' }
    case 'chat_api_error':
      return { kind: 'text', text: content, color: 'text-red-400' }
    case 'permission_retry':
      return {
        kind: 'text',
        text: `Allowed: ${(entry.commands as string[])?.join(', ') || content}`,
        color: 'text-green-400/70',
      }
    case 'stop_hook_summary': {
      const reason = (entry.stopReason as string) || (entry.stop_reason as string) || 'end_turn'
      const numTurns = (entry.numTurns as number) || (entry.num_turns as number)
      const parts = [`Stop: ${reason}`]
      if (numTurns) parts.push(`${numTurns} turns`)
      return { kind: 'text', text: parts.join(' -- '), color: 'text-muted-foreground/50' }
    }
    case 'scheduled_task_fire':
      return {
        kind: 'text',
        text: content
          ? `Scheduled: ${content.length > 80 ? `${content.slice(0, 80)}...` : content}`
          : 'Scheduled task fired',
        color: 'text-amber-400/70',
      }
    case 'hook_feedback': {
      // Entry is a CC user entry carrying the hook reason at message.content
      // (a text-block array, occasionally a bare string) -- not a real system
      // entry, so the system `content` field is empty. Summarize the "<Event>
      // hook feedback:\n<reason>" payload onto one line; the (i) JsonInspector
      // carries the full text.
      const msg = (entry.message as { content?: unknown } | undefined)?.content
      const raw =
        typeof msg === 'string'
          ? msg
          : Array.isArray(msg)
            ? msg.map(b => (b as { text?: string })?.text ?? '').join('')
            : content
      const lines: string[] = []
      for (const l of raw.split('\n')) {
        const trimmed = l.trim()
        if (trimmed) lines.push(trimmed)
      }
      const header = lines[0]?.replace(/\s*feedback:?\s*$/i, '') || 'Hook'
      const reason = lines.slice(1).join(' ')
      const summary = reason ? `${header}: ${reason}` : header
      return {
        kind: 'text',
        text: summary.length > 160 ? `${summary.slice(0, 160)}...` : summary,
        color: 'text-amber-400/70',
      }
    }
    case 'away_summary': {
      const parsed = parseRecapContent(content)
      return {
        kind: 'jsx',
        node: (
          <div className="my-3 mx-auto max-w-[95%]">
            <div className="border border-zinc-600/40 bg-zinc-800/30 rounded px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-zinc-400/70">recap</span>
                <span className="flex-1 h-px bg-zinc-600/30" />
                <TimeStamp ts={ts} className="text-muted-foreground/40 text-[10px]" />
                <JsonInspector title="away_summary" data={entry} raw={entry} />
              </div>
              <div className="text-[11px] text-zinc-300/80 leading-relaxed">
                {parsed.title && <span className="font-medium text-zinc-200/90">{parsed.title}: </span>}
                {parsed.recap}
              </div>
            </div>
          </div>
        ),
      }
    }
    // --- CC 2.1.160 OUT subtypes (Class 1, render-only) ---
    case 'model_fallback': {
      const from = (entry.original_model as string) || '?'
      const to = (entry.fallback_model as string) || '?'
      const trigger = (entry.trigger as string) || ''
      return {
        kind: 'text',
        text: `Model fallback: ${from} -> ${to}${trigger ? ` (${trigger})` : ''}`,
        color: 'text-amber-400',
      }
    }
    case 'notification': {
      const text = (entry.text as string) || content
      if (!text) return null
      const priority = entry.priority as string | undefined
      return {
        kind: 'text',
        text,
        color: priority === 'high' ? 'text-amber-400' : 'text-cyan-400/70',
      }
    }
    case 'permission_denied': {
      const tool = (entry.tool_name as string) || 'tool'
      const agentId = entry.agent_id as string | undefined
      return {
        kind: 'text',
        text: `Permission denied: ${tool}${agentId ? ' (subagent)' : ''}`,
        color: 'text-red-400',
      }
    }
    case 'mirror_error':
      return {
        kind: 'text',
        text: `Transcript mirror error: ${(entry.error as string) || 'unknown'}`,
        color: 'text-red-400',
      }
    case 'task_updated': {
      const err = entry.error as string | undefined
      const desc = entry.description as string | undefined
      if (err) return { kind: 'text', text: `Task error: ${err}`, color: 'text-red-400' }
      if (entry.is_backgrounded) return { kind: 'text', text: 'Task backgrounded', color: 'text-muted-foreground/70' }
      if (desc) return { kind: 'text', text: `Task: ${desc}`, color: 'text-muted-foreground/70' }
      return null
    }
    case 'memory_recall': {
      const memories = entry.memories as unknown[] | undefined
      const mode = entry.mode as string | undefined
      const n = Array.isArray(memories) ? memories.length : 0
      return {
        kind: 'text',
        text: `Recalled ${n} ${n === 1 ? 'memory' : 'memories'}${mode ? ` (${mode})` : ''}`,
        color: 'text-cyan-400/70',
      }
    }
    case 'files_persisted': {
      const files = entry.files as unknown[] | undefined
      const failed = entry.failed as unknown[] | undefined
      const n = Array.isArray(files) ? files.length : 0
      const f = Array.isArray(failed) ? failed.length : 0
      return {
        kind: 'text',
        text: `Saved ${n} ${n === 1 ? 'file' : 'files'}${f ? ` (${f} failed)` : ''}`,
        color: f ? 'text-red-400/80' : 'text-cyan-400/70',
      }
    }
    case 'plugin_install': {
      const status = (entry.status as string) || ''
      const name = (entry.name as string) || ''
      const err = entry.error as string | undefined
      return {
        kind: 'text',
        text: `Plugin install${name ? ` ${name}` : ''}: ${status}${err ? ` -- ${err}` : ''}`,
        color: status === 'failed' ? 'text-red-400' : 'text-muted-foreground/70',
      }
    }
    case 'hook_progress': {
      const name = (entry.hook_name as string) || 'hook'
      const event = (entry.hook_event as string) || ''
      return {
        kind: 'text',
        text: `Hook ${name}${event ? ` (${event})` : ''}`,
        color: 'text-muted-foreground/50',
      }
    }
    case 'elicitation_complete':
      return {
        kind: 'text',
        text: `Elicitation complete${entry.mcp_server_name ? ` (${entry.mcp_server_name})` : ''}`,
        color: 'text-muted-foreground/70',
      }
    // task_summary is CC's ephemeral terminal-title classifier, not a transcript
    // line -- and it does not fire in headless anyway. Belt-and-suspenders: never
    // render it inline even if one slips through.
    case 'task_summary':
      return null
    case 'background_tasks_changed':
      return { kind: 'jsx', node: <BgTasksHint entry={entry} ts={ts} /> }
    default:
      return { kind: 'text', text: content || `[${sub}]`, color: 'text-muted-foreground' }
  }
}

export function SystemLine({ group, ts }: { group: DisplayGroup; ts?: string | number }) {
  const entry = group.entries[0] as Record<string, unknown>
  const sub = group.systemSubtype || ''
  const result = describeSystemEntry(sub, entry, ts)
  if (!result) return null
  if (result.kind === 'jsx') return result.node

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <span className={result.color}>{result.text}</span>
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={sub || 'system'} data={entry} raw={entry} />
    </div>
  )
}

// Inline variant rendered inside an assistant group's body. Left-aligned,
// tighter margin, same content + color as the standalone SystemLine.
export function SystemLineInline({
  entry,
  subtype,
  ts,
}: {
  entry: Record<string, unknown>
  subtype: string
  ts?: string | number
}) {
  const result = describeSystemEntry(subtype, entry, ts)
  if (!result) return null
  if (result.kind === 'jsx') return result.node

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className={result.color}>{result.text}</span>
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={subtype || 'system'} data={entry} raw={entry} />
    </div>
  )
}

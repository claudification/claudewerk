import type {
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptQueueEntry,
  TranscriptUserEntry,
} from '@/lib/types'
import type { TaskNotification } from './types'

export function isUser(e: TranscriptEntry): e is TranscriptUserEntry {
  return e.type === 'user'
}

export function isQueue(e: TranscriptEntry): e is TranscriptQueueEntry {
  return e.type === 'queue-operation'
}

// System subtypes that carry NO transcript-visible content: CC's per-API-request
// `status` heartbeat, internal snapshots, and subagent-only progress. grouping
// skips them (handleSystem), and the progressive window must not count them
// toward its displayable budget. Single source of truth -- keep in sync with the
// skips in process-entry.ts (which imports this set).
export const NOISE_SYSTEM_SUBTYPES = new Set([
  'status',
  'file_snapshot',
  'post_turn_summary',
  'task_progress',
  'task_notification',
])

// A user entry whose content carries a tool_result block -- the OUTPUT of a tool
// call. It renders INSIDE the originating tool_use line, never as its own
// transcript item, so it must not count as a displayable entry (every tool call
// is otherwise 2 raw entries -- the tool_use + this -- for 1 visible item).
export function isToolResultUserEntry(e: TranscriptEntry): boolean {
  if (e.type !== 'user') return false
  const c = (e as TranscriptUserEntry).message?.content
  return Array.isArray(c) && c.some(b => (b as { type?: string }).type === 'tool_result')
}

// Mirrors mergeMessageEntry's content gate: a user/assistant message renders only
// if it carries non-empty text, thinking, or a tool_use block. Used by both the
// grouper (drop empties) and the window budget (don't count empties).
export function hasRenderableMessageContent(e: TranscriptEntry): boolean {
  const c = (e as TranscriptUserEntry | TranscriptAssistantEntry).message?.content
  if (typeof c === 'string') return !!c.trim()
  if (!Array.isArray(c)) return false
  return c.some(
    b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && (b.thinking?.trim() || b.text?.trim() || b.signature)) ||
      b.type === 'tool_use',
  )
}

// Would this entry contribute a VISIBLE transcript item? The progressive window
// budgets by displayable entries, not raw ones -- otherwise `status` heartbeats
// and tool_result entries eat the last-N slice before ~WINDOW_SIZE real items
// load (the sparse-open bug). Deliberately conservative: it nails the dominant
// noise (status, tool_result, empty messages) and treats anything ambiguous as
// displayable, so the window can only ever err toward loading MORE real content,
// never less. Non-message entries (boot/launch/shell/advisor/compact/queue) all
// render cards -> displayable.
export function isDisplayableEntry(e: TranscriptEntry): boolean {
  if (e.type === 'system') {
    const sub = (e as { subtype?: string }).subtype
    return !(sub && NOISE_SYSTEM_SUBTYPES.has(sub))
  }
  if (e.type === 'user') return !isToolResultUserEntry(e) && hasRenderableMessageContent(e)
  if (e.type === 'assistant') return hasRenderableMessageContent(e)
  return true
}

const CHANNEL_BLOCK_RE = /^<channel\s+([^>]*)>\n?[\s\S]*?\n?<\/channel>$/

// A user entry whose entire content is a <channel> block that the transcript
// renderer turns into a full-width, self-describing CARD -- an inter-conversation
// message, a dialog submission, or an rclaude system notice -- rather than a chat
// bubble. Such an entry forces its whole group out of bubble mode (see
// group-view.tsx `hasInterConversationContent`), so it must NOT share a group with
// the user's own typed text: otherwise that text loses its bubble and renders as
// bare markdown under the card (the merged-bubble bug). The grouper uses this to
// split channel cards from plain user turns. Mirrors `parseChannelContent` in
// parse-entries.ts -- keep the two card kinds in sync.
export function isCardChannelEntry(e: TranscriptEntry): boolean {
  if (e.type !== 'user') return false
  const content = (e as TranscriptUserEntry).message?.content
  if (typeof content !== 'string') return false
  const m = content.trim().match(CHANNEL_BLOCK_RE)
  if (!m) return false
  const attr = (name: string) => m[1].match(new RegExp(`${name}="([^"]*)"`))?.[1]
  const sender = attr('sender')
  const source = attr('source') || 'unknown'
  const fromProject = attr('from_project')
  // Inter-conversation (sender=conversation|session + from_project), dialog, or system notice.
  if ((sender === 'conversation' || sender === 'session') && fromProject) return true
  if (sender === 'dialog' || sender === 'dialog-untrusted') return true
  if (source === 'rclaude' && sender === 'system') return true
  return false
}

// Parse <task-notification> XML into structured data using DOMParser
export function parseTaskNotifications(text: string): TaskNotification[] {
  const results: TaskNotification[] = []
  const blockRegex = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g
  let blockMatch: RegExpExecArray | null = blockRegex.exec(text)
  while (blockMatch !== null) {
    const xml = `<root>${blockMatch[1]}</root>`
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml')
      const taskId = doc.querySelector('task-id')?.textContent?.trim() || ''
      const status = doc.querySelector('status')?.textContent?.trim() || ''
      const summary = doc.querySelector('summary')?.textContent?.trim() || ''
      const result = doc.querySelector('result')?.textContent?.trim() || undefined
      const toolUseId = doc.querySelector('tool-use-id')?.textContent?.trim() || undefined
      const outputFile = doc.querySelector('output-file')?.textContent?.trim() || undefined

      // Parse usage block: <usage><total_tokens>N</total_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
      let usage: TaskNotification['usage']
      const usageEl = doc.querySelector('usage')
      if (usageEl) {
        const totalTokens = Number.parseInt(usageEl.querySelector('total_tokens')?.textContent || '0', 10)
        const toolUses = Number.parseInt(usageEl.querySelector('tool_uses')?.textContent || '0', 10)
        const durationMs = Number.parseInt(usageEl.querySelector('duration_ms')?.textContent || '0', 10)
        if (totalTokens || toolUses || durationMs) {
          usage = { totalTokens, toolUses, durationMs }
        }
      }

      if (taskId || summary) {
        results.push({ taskId, status, summary, result, toolUseId, outputFile, usage })
      }
    } catch {
      // Malformed XML - skip
    }
    blockMatch = blockRegex.exec(text)
  }
  return results
}

// Extract skill/command name from a user entry that precedes skill content injection.
// Path A: tool_result with toolUseResult.commandName (Skill tool)
// Path B: <command-message>name</command-message> (direct /slash command)
export function extractSkillName(entry: TranscriptUserEntry): string | undefined {
  const extra = entry.toolUseResult as Record<string, unknown> | undefined
  if (extra?.commandName) return extra.commandName as string
  const text = typeof entry.message?.content === 'string' ? entry.message.content : ''
  const match = text.match(/<command-message>([^<]+)<\/command-message>/)
  return match?.[1]
}

// Detect if a user entry is the injected body that follows a skill/command
// invocation -- the big markdown dump after a Skill tool call (`# Protocol...`)
// OR a built-in slash command's injected payload (e.g. the `/insights` report,
// which opens with prose like "The user just ran /insights", not `#`).
//
// `isMeta` marks an injected, non-user-turn entry. The agent host populates it
// in both transports -- natively from CC's JSONL (PTY) and normalized from
// stream-json `isSynthetic` (headless) -- so detection relies on it. We accept
// ANY non-empty meta text here rather than sniffing a `#` prefix, because
// built-in commands don't use the skill-body marker. The call site gates this
// on `pendingSkillName`, so only the entry immediately following an invocation
// can match -- a stray meta entry or paste can't.
export function isSkillContent(entry: TranscriptUserEntry): boolean {
  if (entry.isMeta !== true) return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false
  return content.some(c => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0)
}

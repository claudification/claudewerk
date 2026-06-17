import type { TranscriptEntry, TranscriptQueueEntry, TranscriptUserEntry } from '@/lib/types'
import type { TaskNotification } from './types'

export function isUser(e: TranscriptEntry): e is TranscriptUserEntry {
  return e.type === 'user'
}

export function isQueue(e: TranscriptEntry): e is TranscriptQueueEntry {
  return e.type === 'queue-operation'
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

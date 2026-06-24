import type { TranscriptEntry, TranscriptSystemEntry, TranscriptUserEntry } from './protocol'

const NOISE_SYSTEM_SUBTYPES = new Set(['file_snapshot', 'post_turn_summary', 'task_progress', 'task_notification'])

function isToolResultOnly(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false
  const content = (entry as TranscriptUserEntry).message?.content
  if (!Array.isArray(content)) return false
  return content.every(c => c.type === 'tool_result')
}

// A Skill-tool invocation lands as a tool_result-only user entry carrying the
// skill name in `toolUseResult.commandName`. The transcript grouper consumes
// this entry purely to stash `pendingSkillName` (it renders nothing itself), so
// the *next* entry -- the injected `isMeta` skill body -- can fold into a skill
// chip instead of a plain user bubble. If `filter=display` drops it as
// tool_result noise (the cold-open/reload path), the body loses its name gate
// and renders as a stray user chat bubble after a conversation switch. Keep it.
function isSkillInvocation(entry: TranscriptEntry): boolean {
  const meta = (entry as { toolUseResult?: { commandName?: unknown } }).toolUseResult
  return typeof meta?.commandName === 'string' && meta.commandName.length > 0
}

function isNoiseSystem(entry: TranscriptEntry): boolean {
  if (entry.type !== 'system') return false
  const sys = entry as TranscriptSystemEntry
  if (!sys.subtype) return true
  return NOISE_SYSTEM_SUBTYPES.has(sys.subtype)
}

export function isDisplayEntry(entry: TranscriptEntry): boolean {
  if (entry.type === 'progress') return false
  if (isNoiseSystem(entry)) return false
  if (isToolResultOnly(entry) && !isSkillInvocation(entry)) return false
  return true
}

export function filterDisplayEntries(entries: TranscriptEntry[], limit?: number): TranscriptEntry[] {
  if (!limit) return entries.filter(isDisplayEntry)
  const result: TranscriptEntry[] = []
  for (let i = entries.length - 1; i >= 0 && result.length < limit; i--) {
    if (isDisplayEntry(entries[i])) result.push(entries[i])
  }
  result.reverse()
  return result
}

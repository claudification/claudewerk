import type { TranscriptEntry, TranscriptSystemEntry, TranscriptUserEntry } from './protocol'

const NOISE_SYSTEM_SUBTYPES = new Set(['file_snapshot', 'post_turn_summary', 'task_progress', 'task_notification'])

function isToolResultOnly(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false
  const content = (entry as TranscriptUserEntry).message?.content
  if (!Array.isArray(content)) return false
  return content.every(c => c.type === 'tool_result')
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
  if (isToolResultOnly(entry)) return false
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

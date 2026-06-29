/**
 * Client-side voice recording history.
 *
 * Persists every voice transcription result (raw + refined + timestamp +
 * conversationId) to localStorage with 24h auto-decay. Recoverable via
 * command palette or the voice UI if a transcript is lost.
 */

const STORAGE_KEY = 'claudewerk-voice-history'
const MAX_ENTRIES = 50
const DECAY_MS = 24 * 60 * 60 * 1000 // 24h

export interface VoiceHistoryEntry {
  raw: string
  refined: string
  conversationId: string | null
  ts: number
  recovered?: boolean
}

function readEntries(): VoiceHistoryEntry[] {
  try {
    const json = localStorage.getItem(STORAGE_KEY)
    if (!json) return []
    return JSON.parse(json) as VoiceHistoryEntry[]
  } catch {
    return []
  }
}

function writeEntries(entries: VoiceHistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage full or unavailable -- silently fail
  }
}

function pruneExpired(entries: VoiceHistoryEntry[]): VoiceHistoryEntry[] {
  const cutoff = Date.now() - DECAY_MS
  return entries.filter(e => e.ts > cutoff)
}

export function addVoiceHistoryEntry(entry: Omit<VoiceHistoryEntry, 'ts'>): void {
  const entries = pruneExpired(readEntries())
  entries.push({ ...entry, ts: Date.now() })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  writeEntries(entries)
}

export function getVoiceHistory(): VoiceHistoryEntry[] {
  const entries = pruneExpired(readEntries())
  writeEntries(entries) // persist the prune
  return entries
}

// fallow-ignore-next-line unused-export
export function clearVoiceHistory(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// fallow-ignore-next-line unused-export
export function getLatestVoiceEntry(): VoiceHistoryEntry | null {
  const entries = getVoiceHistory()
  return entries.length > 0 ? entries[entries.length - 1] : null
}

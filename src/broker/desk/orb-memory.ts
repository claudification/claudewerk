/**
 * SCRAPLORD'S MEMORY -- small, keyed, per-user, JSON on disk.
 *
 * Distinct from the two blobs next door, deliberately:
 *   - `dispatch-memory.md` is the dispatcher's OWN rolling digest (LLM-curated),
 *   - `user-notes.md` is the user's freeform notepad (one document),
 *   - this is a KEY/VALUE store, because "what do you remember?" and "forget
 *     that" need addressable entries. A blob cannot be listed or deleted from.
 *
 * Bounded on purpose: voice is a firehose and the orb writes here unattended, so
 * keys and values are capped and the oldest entries fall off past the limit.
 * Losing the 201st memory beats an unbounded file the orb slowly fills with
 * mishearings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface Memory {
  key: string
  value: string
  updatedAt: number
}

/** Per-user bag of memories, keyed by the (normalised) memory key. */
type MemoryFile = Record<string, Record<string, Memory>>

export const MAX_MEMORIES_PER_USER = 200
const MAX_KEY_LENGTH = 80
export const MAX_VALUE_LENGTH = 2000

let memoryFile: string | null = null

/** Point the store at its file (mirrors initUserNotes). */
export function initOrbMemory(cacheDir: string): void {
  memoryFile = resolve(cacheDir, 'voice-orb-memory.json')
}

/** Test/explicit override of the file path. */
export function setOrbMemoryFile(path: string | null): void {
  memoryFile = path
}

/** Everything is keyed case-insensitively: he will not say it the same way twice. */
function normaliseKey(key: string): string {
  return key.trim().toLowerCase().slice(0, MAX_KEY_LENGTH)
}

function bucketFor(userId: string | null | undefined): string {
  return userId?.trim() || 'default'
}

function readFile(): MemoryFile {
  if (!memoryFile || !existsSync(memoryFile)) return {}
  try {
    const parsed = JSON.parse(readFileSync(memoryFile, 'utf8')) as MemoryFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A corrupt file must not take the broker down or wipe itself silently on
    // the next write -- treat it as empty and let the next save rebuild it.
    return {}
  }
}

function writeFile(data: MemoryFile): void {
  if (!memoryFile) return
  mkdirSync(dirname(memoryFile), { recursive: true })
  writeFileSync(memoryFile, JSON.stringify(data, null, 2), 'utf8')
}

/** Oldest-first eviction once a user is over the cap. */
function evict(bag: Record<string, Memory>): Record<string, Memory> {
  const entries = Object.values(bag)
  if (entries.length <= MAX_MEMORIES_PER_USER) return bag
  const keep = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MEMORIES_PER_USER)
  return Object.fromEntries(keep.map(m => [m.key, m]))
}

/** Save (or overwrite) one memory. Returns what was stored. */
export function rememberMemory(
  userId: string | null | undefined,
  key: string,
  value: string,
  now = Date.now(),
): { saved: Memory } | { error: string } {
  const k = normaliseKey(key)
  if (!k) return { error: 'a memory needs a name' }
  const v = value.trim().slice(0, MAX_VALUE_LENGTH)
  if (!v) return { error: 'a memory needs something to remember' }

  const data = readFile()
  const bucket = bucketFor(userId)
  const bag = { ...(data[bucket] ?? {}) }
  const saved: Memory = { key: k, value: v, updatedAt: now }
  bag[k] = saved
  data[bucket] = evict(bag)
  writeFile(data)
  return { saved }
}

/** One memory by name, or null when nothing is stored under it. */
export function recallMemory(userId: string | null | undefined, key: string): Memory | null {
  return readFile()[bucketFor(userId)]?.[normaliseKey(key)] ?? null
}

/** Everything this user has, newest first. */
export function listMemories(userId: string | null | undefined): Memory[] {
  return Object.values(readFile()[bucketFor(userId)] ?? {}).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Delete one memory. Returns what was removed so the caller can read it back
 *  -- a deletion the user cannot hear is a deletion he cannot correct. */
export function forgetMemory(userId: string | null | undefined, key: string): { forgot: Memory } | { error: string } {
  const k = normaliseKey(key)
  const data = readFile()
  const bucket = bucketFor(userId)
  const existing = data[bucket]?.[k]
  if (!existing) return { error: `nothing remembered under "${key}"` }
  const bag = { ...data[bucket] }
  delete bag[k]
  data[bucket] = bag
  writeFile(data)
  return { forgot: existing }
}

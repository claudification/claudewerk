/**
 * Message outbox -- undelivered user messages, held for explicit retry.
 *
 * A posted message can fail to reach the model in two ways, and BOTH used to
 * lose the text:
 *   1. The dashboard socket is down (broker offline) -- `wsSend` returns false.
 *      Only the input bar restored the text; every other caller (voice, project
 *      board, task batch, canvas, sub-commands, web-control) dropped it.
 *   2. The socket is up but the agent host is gone -- `wsSend` returns true, the
 *      input clears optimistically, then the broker replies
 *      `send_input_result ok:false` and the text is unrecoverable.
 *
 * Both paths now land here. Delivery is NEVER retried automatically: a prompt
 * written twenty minutes ago should not silently fire the moment the broker
 * comes back. The user retries, edits, or discards it.
 *
 * Persisted to localStorage so an outbox survives a refresh or a closed tab.
 */

import { create } from 'zustand'

export type OutboxEntry = {
  id: string
  conversationId: string
  text: string
  /** Where the send came from (voice, board, ...) -- replayed on retry. */
  source?: string
  /** Why the last delivery attempt failed. */
  error: string
  /** First-failure timestamp (ms). Drives TTL pruning. */
  ts: number
  /** Delivery attempts so far, including the one that created this entry. */
  attempts: number
}

export type OutboxMap = Record<string, OutboxEntry[]>

const STORAGE_KEY = 'messageOutbox'
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PER_CONVERSATION = 50

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function isEntry(e: unknown): e is OutboxEntry {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.text === 'string' && typeof r.ts === 'number'
}

/** Parse + prune persisted state. Tolerates any shape -- a corrupt blob must
 *  never take the input bar down with it. */
export function loadOutbox(raw: string | null, now = Date.now()): OutboxMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const cutoff = now - TTL_MS
    const out: OutboxMap = {}
    for (const [conversationId, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue
      const fresh = entries
        .filter(isEntry)
        .filter(e => e.ts >= cutoff)
        .slice(-MAX_PER_CONVERSATION)
        .map(e => ({ ...e, conversationId, attempts: e.attempts ?? 1, error: e.error ?? 'Not delivered' }))
      if (fresh.length > 0) out[conversationId] = fresh
    }
    return out
  } catch {
    return {}
  }
}

function readStorage(): OutboxMap {
  try {
    return loadOutbox(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

function writeStorage(map: OutboxMap) {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
}

/** Append an entry to a conversation's queue, capped oldest-first. */
export function appendEntry(map: OutboxMap, entry: OutboxEntry): OutboxMap {
  const queue = map[entry.conversationId] ?? []
  return { ...map, [entry.conversationId]: [...queue, entry].slice(-MAX_PER_CONVERSATION) }
}

/** Drop an entry; removes the conversation key entirely when it empties. */
export function dropEntry(map: OutboxMap, conversationId: string, id: string): OutboxMap {
  const queue = map[conversationId]
  if (!queue) return map
  const next = queue.filter(e => e.id !== id)
  const copy = { ...map }
  if (next.length === 0) delete copy[conversationId]
  else copy[conversationId] = next
  return copy
}

type OutboxState = {
  entries: OutboxMap
  /** Queue an undelivered message. Returns the stored entry. */
  enqueue: (input: {
    conversationId: string
    text: string
    error: string
    source?: string
    attempts?: number
  }) => OutboxEntry
  /** Remove one entry (delivered, discarded, or pulled back into the editor). */
  remove: (conversationId: string, id: string) => void
  /** Record a failed retry: bump attempts, refresh the error. */
  markFailed: (conversationId: string, id: string, error: string) => void
  /** Drop every entry for a conversation. */
  clear: (conversationId: string) => void
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  entries: readStorage(),

  enqueue: ({ conversationId, text, error, source, attempts }) => {
    const entry: OutboxEntry = {
      id: newId(),
      conversationId,
      text,
      error,
      ts: Date.now(),
      attempts: attempts ?? 1,
      ...(source && { source }),
    }
    const next = appendEntry(get().entries, entry)
    writeStorage(next)
    set({ entries: next })
    return entry
  },

  remove: (conversationId, id) => {
    const next = dropEntry(get().entries, conversationId, id)
    writeStorage(next)
    set({ entries: next })
  },

  markFailed: (conversationId, id, error) => {
    const queue = get().entries[conversationId]
    if (!queue) return
    const next = {
      ...get().entries,
      [conversationId]: queue.map(e => (e.id === id ? { ...e, error, attempts: e.attempts + 1 } : e)),
    }
    writeStorage(next)
    set({ entries: next })
  },

  clear: conversationId => {
    const copy = { ...get().entries }
    delete copy[conversationId]
    writeStorage(copy)
    set({ entries: copy })
  },
}))

/** Non-reactive enqueue for module-scope callers (sendInput, WS handlers). */
export function enqueueOutbox(input: {
  conversationId: string
  text: string
  error: string
  source?: string
}): OutboxEntry {
  return useOutboxStore.getState().enqueue(input)
}

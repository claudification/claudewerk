/**
 * Pinned conversations -- the mobile quick-switch set.
 *
 * Persisted in localStorage (same shape as the `collapsed-groups` set in
 * project-list.tsx). Up to MAX_PINS conversations the user explicitly pins for
 * one-tap switching on a phone. The switch strip auto-fills any empty slots
 * with the most-recently-active running conversations, so it is useful before
 * anything is pinned (see `computeSwitchSlots`).
 */

import { create } from 'zustand'
import type { Conversation } from './types'

const STORAGE_KEY = 'pinned-conversations'
export const MAX_PINS = 5

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, MAX_PINS) : []
  } catch {
    return []
  }
}

function save(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // localStorage unavailable (private mode / quota) -- pins are best-effort
  }
}

interface PinnedState {
  /** Ordered list of pinned conversation ids (oldest pin first). */
  pinnedIds: string[]
  /** Pin or unpin a conversation. Newest pin wins when over the cap. */
  togglePin: (id: string) => void
}

export const usePinnedConversations = create<PinnedState>(set => ({
  pinnedIds: load(),
  togglePin: (id: string) =>
    set(state => {
      const has = state.pinnedIds.includes(id)
      // Unpin: drop it. Pin: append, then keep the newest MAX_PINS.
      const next = has ? state.pinnedIds.filter(x => x !== id) : [...state.pinnedIds, id].slice(-MAX_PINS)
      save(next)
      return { pinnedIds: next }
    }),
}))

/**
 * The conversations to show in the quick-switch strip, in display order:
 * pinned ones first (in pin order, even if ended), then the most-recently-active
 * RUNNING conversations to fill any remaining slots. Capped at MAX_PINS.
 */
export function computeSwitchSlots(conversations: Conversation[], pinnedIds: string[]): Conversation[] {
  const byId = new Map(conversations.map(c => [c.id, c]))
  const pinned = pinnedIds.map(id => byId.get(id)).filter((c): c is Conversation => c !== undefined)
  const pinnedSet = new Set(pinned.map(c => c.id))

  const slots = [...pinned]
  if (slots.length < MAX_PINS) {
    const recentActive = conversations
      .filter(c => c.status !== 'ended' && !pinnedSet.has(c.id))
      .sort((a, b) => b.lastActivity - a.lastActivity)
    for (const c of recentActive) {
      if (slots.length >= MAX_PINS) break
      slots.push(c)
    }
  }
  return slots
}

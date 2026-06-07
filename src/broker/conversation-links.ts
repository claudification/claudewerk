/**
 * Conversation Links - persistent conversation-pair links for inter-conversation
 * messaging. Unlike project links (project-links.ts), these are scoped to a SINGLE
 * pair of conversations -- granting them does NOT open messaging between sibling or
 * future conversations in the same projects.
 *
 * Keyed by conversation id (stable forever -- survives /clear, revive, reboot).
 * Backed by the StoreDriver KVStore. Mirror of project-links.ts, minus the project
 * URI normalization (conversation ids are opaque, no canonicalization needed).
 */

import { orderedPair, pairKey } from './link-key'
import type { KVStore } from './store/types'

export interface PersistedConvLink {
  convA: string // sorted-first conversation id
  convB: string // sorted-second conversation id
  createdAt: number
  lastUsed: number
}

const KV_KEY = 'conversation-links'

let kv: KVStore | null = null
let links: PersistedConvLink[] = []

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, links)
}

export function initConversationLinks(store: KVStore): void {
  kv = store
  const raw = kv.get<PersistedConvLink[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    links = raw
    // Evict links not used in 90 days.
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
    const before = links.length
    links = links.filter(l => l.lastUsed > cutoff)
    if (links.length < before) save()
    console.log(
      `[conv-links] Loaded ${links.length} persisted conversation links (evicted ${before - links.length} stale)`,
    )
  } else {
    links = []
  }
}

export function findConvLink(convA: string, convB: string): PersistedConvLink | null {
  const key = pairKey(convA, convB)
  return links.find(l => pairKey(l.convA, l.convB) === key) || null
}

export function addPersistedConvLink(convA: string, convB: string): PersistedConvLink {
  const existing = findConvLink(convA, convB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
    return existing
  }
  const [a, b] = orderedPair(convA, convB)
  const link: PersistedConvLink = { convA: a, convB: b, createdAt: Date.now(), lastUsed: Date.now() }
  links.push(link)
  save()
  console.log(`[conv-links] Persisted: ${a.slice(0, 8)} <-> ${b.slice(0, 8)}`)
  return link
}

export function removePersistedConvLink(convA: string, convB: string): boolean {
  const key = pairKey(convA, convB)
  const idx = links.findIndex(l => pairKey(l.convA, l.convB) === key)
  if (idx >= 0) {
    const removed = links.splice(idx, 1)[0]
    save()
    console.log(`[conv-links] Removed: ${removed.convA.slice(0, 8)} <-> ${removed.convB.slice(0, 8)}`)
    return true
  }
  return false
}

export function touchConvLink(convA: string, convB: string): void {
  const existing = findConvLink(convA, convB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
  }
}

export function getConvLinksFor(conversationId: string): PersistedConvLink[] {
  return links.filter(l => l.convA === conversationId || l.convB === conversationId)
}

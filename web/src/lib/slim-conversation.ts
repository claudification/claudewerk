/**
 * List-resident conversation slimming (heap-pressure reduction).
 *
 * WHY: the broker's WS bulk `conversations` list and every `conversation_update`
 * carry the FULL conversation shape (recap.content, costTimeline[<=500],
 * archivedTasks[], taskSubjects{}, ...). The control panel hydrates ALL
 * conversations (~1086 in prod) from the bulk list at connect, so every one of
 * those fat objects stays resident in the Zustand store. Per-conversation size
 * dominates JS heap (Object + string classes) and directly scales GC pause time
 * (two ~341ms GC pauses were the #1 frame-jank source).
 *
 * The list view (`conversation-item-compact`) only needs lightweight fields plus
 * a SINGLE truncated line of recap.content. The heavy, full-fidelity fields are
 * only consumed by detail surfaces (header-expanded-panel sparkline, info
 * dialog, transcript tool-cases) -- all of which read
 * `conversationsById[selectedConversationId]`, i.e. the OPEN conversation only.
 *
 * STRATEGY: keep a slim object in the list-resident store for every
 * conversation, but retain the full payload for the selected/open conversation
 * (plus a small recency window) by re-hydrating it from a side-map of full
 * payloads. The side-map (`fullById`) is module-level (NOT in Zustand) so
 * writing to it never triggers a React re-render. It is a bounded LRU: the long
 * tail of inactive conversations drops its heavy fields from the heap entirely.
 *
 * GRACEFUL DEGRADATION (never undefined): if a long-idle conversation's full
 * payload has aged out of the LRU when it is selected, detail surfaces fall back
 * to the slim values -- the cost sparkline simply does not render (it already
 * guards `costTimeline.length >= 2`), recap.content shows the bounded preview
 * (the recap VIEWER fetches the full doc via its own API, unaffected), and
 * archived tasks are refetched via REST by tasks-view. No surface reads undefined.
 *
 * NO DATA LOSS COVENANT: nothing here drops a structured WIRE message. This is a
 * client-side residency policy on already-delivered data.
 */

import type { Conversation } from './types'

/** Max chars of recap.content kept on a list-resident (non-selected)
 *  conversation. The list renders recap.content as a single truncated line + a
 *  hover tooltip; 320 chars comfortably fills both at any sane row width. */
export const LIST_RECAP_PREVIEW = 320

/**
 * Heavy fields stripped/truncated from list-resident conversations. Each is
 * either detail-only (selected conversation re-hydrates the full value) or
 * rendered only as a truncated preview in the list row.
 *
 * NOTE: `resultText` is intentionally KEPT intact -- the per-row ResultTextModal
 * renders the full body for any ad-hoc conversation, ad-hoc conversations are a
 * small subset, and the text is typically short.
 */
function slimHeavyFields(c: Conversation): Partial<Conversation> {
  const patch: Partial<Conversation> = {}

  // costTimeline: up to 500 {t,cost} points (~15KB). Only the header-expanded
  // sparkline (selected-only) reads it.
  if (c.costTimeline !== undefined) patch.costTimeline = undefined

  // recap.content: full recap markdown (multi-KB). List shows one truncated
  // line; keep a bounded preview + title/timestamp. The recap VIEWER fetches the
  // full doc via its own API, so it is unaffected.
  if (c.recap && typeof c.recap.content === 'string' && c.recap.content.length > LIST_RECAP_PREVIEW) {
    patch.recap = { ...c.recap, content: c.recap.content.slice(0, LIST_RECAP_PREVIEW) }
  }

  // archivedTasks[]: full archived-task list. The list uses archivedTaskCount
  // (kept); the array is detail-only (tasks-view refetches via REST).
  if (c.archivedTasks !== undefined) patch.archivedTasks = undefined

  // taskSubjects{}: id->subject map for transcript tool-cases (selected-only).
  if (c.taskSubjects !== undefined) patch.taskSubjects = undefined

  return patch
}

/**
 * Return a list-resident (slim) view of a conversation. Returns the input
 * unchanged when there is nothing heavy to strip (avoids a needless clone +
 * keeps reference identity stable for memoized list rows).
 */
export function slimConversation(c: Conversation): Conversation {
  const patch = slimHeavyFields(c)
  if (Object.keys(patch).length === 0) return c
  return { ...c, ...patch }
}

// ─── side-map of full payloads (module-level, NOT in Zustand) ────────────────

/** Bounded LRU of full conversation payloads, keyed by conversation id.
 *  Insertion order = recency; we evict from the front when over capacity. */
const fullById = new Map<string, Conversation>()

/** How many full payloads to retain. The selected conversation plus a small
 *  recency window (recently-viewed / actively-updating) covers every surface
 *  that needs full fidelity without retaining the long tail. */
const FULL_LRU_MAX = 16

/** Record the full payload for a conversation so the selected one can be
 *  re-hydrated. Touch-on-write keeps recently-updated conversations resident.
 *  `pinned` (the selected id) is never evicted in this pass. */
export function rememberFull(c: Conversation, pinned?: string | null): void {
  if (fullById.has(c.id)) fullById.delete(c.id)
  fullById.set(c.id, c)
  while (fullById.size > FULL_LRU_MAX) {
    let victim: string | undefined
    for (const k of fullById.keys()) {
      if (k !== pinned) {
        victim = k
        break
      }
    }
    if (victim === undefined) break
    fullById.delete(victim)
  }
}

/** Look up the retained full payload for a conversation, or undefined if it has
 *  aged out of the LRU. Touch-on-read keeps it resident. */
export function getFull(id: string): Conversation | undefined {
  const full = fullById.get(id)
  if (full) {
    fullById.delete(id)
    fullById.set(id, full)
  }
  return full
}

/** Drop a conversation's retained full payload (e.g. on dismiss/removal). */
export function forgetFull(id: string): void {
  fullById.delete(id)
}

/** Test-only: clear the side-map between cases. */
export function _resetFullForTests(): void {
  fullById.clear()
}

/**
 * Build a `conversationsById` index where every entry is slim EXCEPT the
 * selected conversation, which is re-hydrated to its full payload from the
 * side-map when available. The array passed in is expected to already hold slim
 * objects (see `ingestConversations`).
 */
export function buildSlimIndexWithSelected(
  slimConversations: Conversation[],
  selectedId: string | null,
): Record<string, Conversation> {
  const map: Record<string, Conversation> = {}
  for (const s of slimConversations) map[s.id] = s
  if (selectedId && map[selectedId]) {
    const full = getFull(selectedId)
    if (full) map[selectedId] = full
  }
  return map
}

/**
 * On a selection change, swap the `conversationsById` index so the newly-selected
 * conversation is full (re-hydrated from the side-map) and the previously-selected
 * one is re-slimmed -- keeping exactly one full conversation resident. Returns the
 * same reference when nothing changed (no needless store write / re-render).
 */
export function rehydrateSelectedIndex(
  byId: Record<string, Conversation>,
  prevId: string | null,
  nextId: string | null,
): Record<string, Conversation> {
  if (prevId === nextId) return byId
  const next = { ...byId }
  let changed = false
  if (prevId && next[prevId]) {
    const reslimmed = slimConversation(next[prevId])
    if (reslimmed !== next[prevId]) {
      next[prevId] = reslimmed
      changed = true
    }
  }
  if (nextId && next[nextId]) {
    const full = getFull(nextId)
    if (full && full !== next[nextId]) {
      next[nextId] = full
      changed = true
    }
  }
  return changed ? next : byId
}

// ─── derived ordered list (conversationsById is the source of truth) ─────────

/** Memo cell for `selectConversations`. The store keeps `conversationsById` as
 *  the authoritative index (W-H3); the ordered `conversations[]` array is DERIVED
 *  here, not stored, so a single-conversation `conversation_update` patches ONE
 *  map key instead of rebuilding the whole array on every fleet message. */
const EMPTY_CONVERSATIONS: Conversation[] = []
let convArrCacheById: Record<string, Conversation> | null = null
let convArrCache: Conversation[] = EMPTY_CONVERSATIONS

/**
 * Derive the ordered `conversations[]` array from the `conversationsById` index.
 * Memoized on the `byId` REFERENCE: returns the identical array instance until
 * the index object itself changes, so Zustand selectors built on it stay stable
 * (no React #185 churn -- this is NOT a fresh-literal-per-render selector).
 *
 * Order is `Object.values` insertion order, which matches the broker's bulk-list
 * order (the index is built by iterating that list). Raw order is not
 * load-bearing anyway: every list surface (sidebar `partitionConversations`,
 * command-palette `sortConversationsForPalette`) re-sorts before render.
 *
 * The selected conversation's entry is the full payload (others are slim); the
 * list renders the same fields from either, so a full entry in the array is
 * harmless (and avoids a duplicate slim clone). Callers MUST NOT mutate the
 * returned array in place (it is shared) -- sort via `.toSorted()` / copy first.
 */
export function selectConversations(byId: Record<string, Conversation>): Conversation[] {
  if (byId === convArrCacheById) return convArrCache
  const arr = Object.values(byId)
  convArrCacheById = byId
  convArrCache = arr
  return arr
}

/** Test-only: reset the derived-list memo between cases. */
export function _resetConversationsMemoForTests(): void {
  convArrCacheById = null
  convArrCache = EMPTY_CONVERSATIONS
}

/**
 * Slim a batch of full conversations for list residency while remembering each
 * full payload in the side-map. Returns the slim array; callers build the index
 * via `buildSlimIndexWithSelected`. `selectedId` is pinned so the open
 * conversation's full payload is never evicted during a bulk ingest.
 */
export function ingestConversations(fullConversations: Conversation[], selectedId?: string | null): Conversation[] {
  const out: Conversation[] = []
  for (const c of fullConversations) {
    rememberFull(c, selectedId)
    out.push(slimConversation(c))
  }
  return out
}

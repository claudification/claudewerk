import type { Conversation } from '@/lib/types'

// ─── Spawn-lineage grouping (Phase 4) ──────────────────────────────────────
//
// A conversation spawned by another (parentConversationId set) shares the
// topmost ancestor's id in rootConversationId. The control panel groups a
// project's conversations by that root so a spawn chain (A -> B -> C) renders
// as one visual cluster: root first, descendants indented one level (single
// level, regardless of actual depth -- the "from {parent}" subtext tells you
// the real parent).

export type LineageRole = 'root' | 'child'

export interface LineageMember {
  conversation: Conversation
  role: LineageRole
  /** Root pulled in from the store for context because it is not in the visible
   *  set (ended/inactive). Rendered dimmed, no action badges. */
  orphanRoot?: boolean
}

export interface LineageGroup {
  /** rootConversationId ?? id shared by every member. */
  key: string
  members: LineageMember[]
}

/** Grouping key: the conversation's root ancestor if known, else itself. */
export function lineageKey(c: Conversation): string {
  return c.rootConversationId ?? c.id
}

/**
 * Root ids referenced by these conversations (via rootConversationId) that are
 * NOT themselves present in the list -- candidates to pull from the store as
 * dimmed orphan roots so the lineage stays visible after the root ends.
 */
export function neededOrphanRootIds(conversations: Conversation[]): string[] {
  const present = new Set(conversations.map(c => c.id))
  const needed = new Set<string>()
  for (const c of conversations) {
    const root = c.rootConversationId
    if (root && !present.has(root)) needed.add(root)
  }
  return [...needed]
}

/**
 * Group conversations by spawn lineage.
 *
 * - Keyed by `rootConversationId ?? id`.
 * - Within a group: root first, then descendants by `startedAt` ascending.
 * - A single-member group (self-rooted, no spawned children present) yields one
 *   `root` member, so it renders exactly as an ungrouped conversation does today.
 * - `orphanRoots` are roots absent from `conversations` (ended/inactive, pulled
 *   from the store). They lead their group flagged `orphanRoot` for dimmed
 *   rendering.
 * - If a group's root is neither present nor pullable (parent chain deleted),
 *   the surviving descendants render as `root` (no dangling indent); their
 *   "from {parent}" subtext degrades to "(deleted)".
 * - Groups are ordered by the newest `startedAt` among their members (desc),
 *   matching the existing newest-first list ordering.
 */
export function groupByLineage(conversations: Conversation[], orphanRoots: Conversation[] = []): LineageGroup[] {
  const orphanById = new Map(orphanRoots.map(c => [c.id, c]))
  const byKey = new Map<string, Conversation[]>()
  for (const c of conversations) {
    const existing = byKey.get(lineageKey(c))
    if (existing) existing.push(c)
    else byKey.set(lineageKey(c), [c])
  }

  return [...byKey.entries()]
    .map(([key, members]) => assembleGroup(key, members, orphanById))
    .sort((a, b) => b.newest - a.newest)
    .map(r => r.group)
}

/** Assemble one lineage group: resolve its root (present or orphan), order
 *  descendants by startedAt, and compute the group's recency for sorting. */
function assembleGroup(
  key: string,
  members: Conversation[],
  orphanById: Map<string, Conversation>,
): { group: LineageGroup; newest: number } {
  const root = members.find(c => c.id === key) ?? orphanById.get(key)
  const orphanRoot = !!root && !members.includes(root)
  const descendants = members.filter(c => c.id !== key).sort((a, b) => a.startedAt - b.startedAt)

  // No resolvable root (parent chain deleted) -> surviving descendants render
  // flat (role 'root') rather than indented under nothing.
  const childRole: LineageRole = root ? 'child' : 'root'
  const ordered: LineageMember[] = root ? [{ conversation: root, role: 'root', ...(orphanRoot && { orphanRoot }) }] : []
  for (const child of descendants) ordered.push({ conversation: child, role: childRole })

  const newest = Math.max(root?.startedAt ?? 0, ...members.map(c => c.startedAt))
  return { group: { key, members: ordered }, newest }
}

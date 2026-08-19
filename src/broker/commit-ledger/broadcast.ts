/**
 * Commit ledger broadcasts -- two tiers, two different threat profiles.
 *
 * `commit_count` is a conversation id and an integer. Cheap enough to send to
 * every permitted panel on every commit, and it discloses nothing a viewer of
 * that conversation cannot already see.
 *
 * `commit_recorded` carries the message, the branch, and every touched path --
 * i.e. HOST DISK STRUCTURE. It is therefore:
 *   - gated on `chat:read` for the commit's own project, and
 *   - withheld from share-link guests OUTRIGHT (the same rule the host-shell
 *     roster follows: a scoped guest link must never surface host paths, which
 *     `repoUri` / `cwdUri` contain verbatim), and
 *   - sent only to sockets that opted in with `commit_subscribe {mode:'full'}`.
 *
 * The first version of this shipped through the unscoped `broadcastToSubscribers`
 * and handed full commit payloads to every connected panel. Do not go back.
 */

import type { CommitRow } from '../../shared/commit-ledger'
import type { ConversationStore } from '../conversation-store'
import { type Permission, resolvePermissions, type UserGrant } from '../permissions'
import { publishWallCommit } from '../wall'
import { wallCommitFromRow } from '../wall/wall-sources'

export type CommitSubscribeMode = 'counts' | 'full'

interface SocketData {
  grants?: UserGrant[]
  shareToken?: string
  shareConversationId?: string
  commitMode?: CommitSubscribeMode
}

interface Options {
  /** Withhold from share-link guests entirely. */
  excludeShareGuests: boolean
  /** Only deliver to sockets that opted into full commit rows. */
  requireFullMode: boolean
}

const READ: Permission = 'chat:read'

interface Target {
  data: SocketData
  project: string
  conversationId: string | null
  options: Options
}

/** THE POLICY. Every reason a socket is refused, named, one predicate each.
 *  A list rather than a chain of `if`s: each rule is independently readable and
 *  independently testable, and adding one is an entry rather than a branch. */
const REFUSALS: Array<{ why: string; refuses: (t: Target) => boolean }> = [
  {
    why: 'share guests never receive host disk paths',
    refuses: t => t.options.excludeShareGuests && Boolean(t.data.shareToken || t.data.shareConversationId),
  },
  {
    why: 'socket did not opt into full commit rows',
    refuses: t => t.options.requireFullMode && t.data.commitMode !== 'full',
  },
  {
    why: 'a conversation-scoped share never sees a sibling conversation',
    refuses: t =>
      Boolean(t.data.shareConversationId) &&
      Boolean(t.conversationId) &&
      t.data.shareConversationId !== t.conversationId,
  },
  {
    // No grants at all = the owner's own panel (admin bearer / cookie session).
    why: 'no chat:read on the commit project',
    refuses: t => Boolean(t.data.grants) && !resolvePermissions(t.data.grants ?? [], t.project).permissions.has(READ),
  },
]

function isEligible(target: Target): boolean {
  return !REFUSALS.some(rule => rule.refuses(target))
}

function deliver(
  conversationStore: ConversationStore,
  message: Record<string, unknown>,
  project: string,
  conversationId: string | null,
  options: Options,
): number {
  const json = JSON.stringify(message)
  let sent = 0
  for (const ws of conversationStore.getSubscribers()) {
    try {
      if (!isEligible({ data: ws.data as SocketData, project, conversationId, options })) continue
      ws.send(json)
      sent++
    } catch {
      /* dead socket -- the store's own reaper removes it */
    }
  }
  return sent
}

export function broadcastCommitRecorded(conversationStore: ConversationStore, commit: CommitRow): number {
  // THE WALL's commit river rides the same event, projected down to a compact
  // row and coalesced at ~2 Hz instead of one send per commit. No-op while the
  // wall is closed. Its own per-subscriber project filter applies on flush, so
  // the disclosure profile here is unchanged.
  publishWallCommit(wallCommitFromRow(commit))
  return deliver(
    conversationStore,
    { type: 'commit_recorded', conversationId: commit.conversationId ?? undefined, commit },
    commit.repoUri,
    commit.conversationId,
    { excludeShareGuests: true, requireFullMode: true },
  )
}

/** The PLACE tier: a project URI and four integers. Same disclosure profile as
 *  the count frame (numbers, no paths beyond the project the socket already
 *  reads), but withheld from share guests -- a scoped guest link has no project
 *  card and no business knowing how much work lives in the place. */
export function broadcastProjectCommitStats(
  conversationStore: ConversationStore,
  project: string,
  stats: Record<string, unknown>,
): number {
  return deliver(conversationStore, { type: 'project_commit_stats', project, stats }, project, null, {
    excludeShareGuests: true,
    requireFullMode: false,
  })
}

export function broadcastCommitCount(
  conversationStore: ConversationStore,
  conversationId: string,
  project: string,
  count: number,
): number {
  return deliver(
    conversationStore,
    { type: 'commit_count', conversationId, commitCount: count },
    project,
    conversationId,
    { excludeShareGuests: false, requireFullMode: false },
  )
}

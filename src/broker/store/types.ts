/**
 * StoreDriver -- pluggable storage backend for the broker.
 *
 * SQLite is the primary driver. MemoryDriver exists for tests.
 * No SQL, no file paths, no storage-specific code outside the driver.
 */

import type { LiveStatus } from '../../shared/protocol'
import type { ScheduledRun } from '../../shared/scheduled-run'
import type { ScheduledTask } from '../../shared/scheduled-task'
import type { RecentWindow } from './recent-window'

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  id: string
  scope: string
  agentType: string
  agentVersion?: string

  title?: string
  summary?: string
  label?: string
  icon?: string
  color?: string

  status: string
  model?: string

  createdAt: number
  endedAt?: number
  lastActivity?: number

  /** Direct spawner. NULL = self-rooted (default for human-started conversations). */
  parentConversationId?: string
  /** Topmost ancestor. NULL = self-rooted. Set once at first persistence; never overwritten. */
  rootConversationId?: string

  /** Addressable slugs this conversation has shed via rename, kept for a decay
   *  window so peers that cached an old name keep routing. JSON column. */
  formerSlugs?: FormerSlug[]

  meta?: Record<string, unknown>
  stats?: ConversationStats
}

/** One retired addressable slug + decay bookkeeping (epoch ms). */
export interface FormerSlug {
  slug: string
  retiredAt: number
  lastUsedAt: number
}

export interface ConversationStats {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCost?: number
  toolCalls?: number
  linesChanged?: number
  turnCount?: number
}

export interface ConversationCreate {
  id: string
  scope: string
  agentType: string
  agentVersion?: string
  title?: string
  model?: string
  meta?: Record<string, unknown>
  createdAt?: number
  /** Spawn parent (the conversation that triggered the spawn). Set ONCE on first
   *  persistence; never overwritten by subsequent updates. */
  parentConversationId?: string
  /** Topmost ancestor in the spawn chain. Set ONCE on first persistence. */
  rootConversationId?: string
  formerSlugs?: FormerSlug[]
}

export interface ConversationPatch {
  status?: string
  model?: string
  /** `undefined` = leave the column alone. `null` = CLEAR it -- a rename back to
   *  the auto-generated name has no title, and without an explicit null the
   *  clear was dropped and the old custom title returned on the next restart. */
  title?: string | null
  summary?: string
  label?: string
  icon?: string
  color?: string
  endedAt?: number
  lastActivity?: number
  formerSlugs?: FormerSlug[]
  meta?: Record<string, unknown>
  stats?: ConversationStats
}

export interface ConversationFilter {
  scope?: string
  status?: string[]
  agentType?: string
  limit?: number
  offset?: number
}

export interface RecentScopeFilter extends Partial<RecentWindow> {
  status?: string[]
  /** Injected so the window is testable without touching the clock. */
  now?: number
}

export interface ConversationSummaryRecord {
  id: string
  scope: string
  agentType: string
  status: string
  model?: string
  title?: string
  label?: string
  icon?: string
  color?: string
  createdAt: number
  endedAt?: number
  lastActivity?: number
  parentConversationId?: string
  rootConversationId?: string
}

/** A conversation's self-reported `set_status` plus the user-impulse timestamp
 *  needed to decide if it's superseded. Read straight from the `meta` JSON via a
 *  targeted index query so the recap never loads the (often hundreds-of-KB) full
 *  meta blob just to read the status. `liveStatus` is undefined for conversations
 *  that never called `set_status`. */
export interface ConversationLiveStatusRecord {
  id: string
  liveStatus?: LiveStatus
  lastInputAt?: number
}

export interface ConversationStore {
  get(id: string): ConversationRecord | null
  create(conversation: ConversationCreate): ConversationRecord
  update(id: string, patch: ConversationPatch): void
  delete(id: string): void
  list(filter?: ConversationFilter): ConversationSummaryRecord[]
  listByScope(scope: string, filter?: { status?: string[] }): ConversationSummaryRecord[]
  /**
   * One project's conversations, newest activity first, bounded by the recent
   * window (see `store/recent-window.ts`): the newest `minCount` OR everything
   * within `withinMs`, whichever reaches further back, capped by `hardCap`.
   *
   * This is what the project summary page asks for. `listByScope` is unbounded
   * and a project can hold 800+ ended conversations, so it is the wrong tool
   * for anything user-facing.
   */
  listRecentByScope(scope: string, filter: RecentScopeFilter): ConversationSummaryRecord[]
  /** Ended-conversation counts per project scope, for badges that must stay
   *  correct even though ended rows are no longer shipped in the load payload. */
  countByScopeAndStatus(status: string[]): Array<{ scope: string; count: number }>
  /** Per-conversation `set_status` for one project scope, read cheaply from the
   *  meta blob (only rows that actually carry a liveStatus). Used by the recap
   *  agent_status signal. Order is unspecified. */
  liveStatusByScope(scope: string): ConversationLiveStatusRecord[]
  /** Every distinct project scope (URI) that has at least one conversation.
   *  The canonical "all projects" enumeration -- e.g. a cross-project ('*')
   *  recap resolves to this list (a literal scope='*' filter matches nothing). */
  listScopes(): string[]
  /** Distinct project scopes with at least one conversation active since
   *  `sinceMs`. The standing project-watch interest set: a board worth watching
   *  is one somebody has actually worked in lately, which is a far smaller list
   *  than every scope ever seen (48 vs 125 on this box at 30 days). */
  listScopesActiveSince(sinceMs: number): string[]
  updateStats(id: string, stats: Partial<ConversationStats>): void
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptEntryRecord {
  id: number
  conversationId: string
  seq: number
  syncEpoch: string
  type: string
  subtype?: string
  agentId?: string
  uuid: string
  content: Record<string, unknown>
  timestamp: number
  ingestedAt: number
}

export interface PageOpts {
  cursor?: number
  limit?: number
  direction?: 'forward' | 'backward'
}

export interface TranscriptPage {
  entries: TranscriptEntryRecord[]
  nextCursor: number | null
  prevCursor: number | null
  totalCount: number
}

export interface TranscriptFilter {
  types?: string[]
  subtypes?: string[]
  agentId?: string | null
  after?: number
  before?: number
  limit?: number
}

export interface SearchHit {
  id: number
  conversationId: string
  seq: number
  type: string
  subtype?: string
  content: Record<string, unknown>
  timestamp: number
  rank: number
  snippet: string
}

/** How to order transcript search hits.
 *  - `relevance` (default): FTS5 bm25 rank, best match first.
 *  - `recency`: newest transcript entry first (date desc), regardless of match quality. */
export type SearchSort = 'relevance' | 'recency'

export interface SearchOpts {
  conversationId?: string
  conversationIds?: string[]
  scope?: string
  types?: string[]
  limit?: number
  offset?: number
  sort?: SearchSort
}

/** Filters for `browse()` -- the query-less twin of SearchOpts. No `sort`: a
 *  listing with no query has no relevance to sort by, so it is always newest-first. */
export interface BrowseOpts {
  conversationId?: string
  conversationIds?: string[]
  types?: string[]
  limit?: number
  offset?: number
}

export interface WindowOpts {
  aroundSeq?: number
  aroundId?: number
  before?: number
  after?: number
  /** Center-free mode: the last N entries of the conversation, chronological.
   *  Ignored when aroundSeq/aroundId is set. Answers "show me the end of this
   *  transcript" without first having to find a seq to center on. */
  tail?: number
}

export interface SearchIndexStats {
  /** Number of source rows in transcript_entries. */
  totalEntries: number
  /** Number of documents currently in the FTS5 inverted index (or totalEntries
   *  for the memory driver, which has no separate index structure). */
  indexedDocs: number
  /** Distinct conversation IDs represented in transcript_entries. */
  conversations: number
  /** indexedDocs == totalEntries -- a quick "is the index up to date?" probe. */
  isComplete: boolean
}

export interface RebuildResult {
  /** Documents present in the rebuilt index. */
  docsIndexed: number
  durationMs: number
}

export interface TranscriptStore {
  /** Append entries, assigning each a monotonic `seq` scoped to its
   *  `(conversationId, agentId)` partition. Parent entries (agentId absent) and
   *  each agent's sub-stream get independent seq spaces, so diverting agent
   *  chatter out of the parent stream never punches gaps in either.
   *
   *  THE STORE IS THE SOLE SEQ AUTHORITY. Callers must take the seq from the
   *  returned results rather than numbering entries themselves -- an in-memory
   *  counter cannot survive a broker restart, and one that tried produced
   *  transcripts whose broadcast seq disagreed with the stored seq for 10% of
   *  all rows. Results come back in input order, one per input entry; a uuid
   *  that already exists reports `inserted: false` and the EXISTING row's seq,
   *  and does NOT consume a number. */
  append(conversationId: string, syncEpoch: string, entries: TranscriptEntryInput[]): TranscriptAppendResult[]
  getPage(conversationId: string, opts: PageOpts & { agentId?: string | null }): TranscriptPage
  getLatest(conversationId: string, limit: number, agentId?: string | null): TranscriptEntryRecord[]
  /** Delta sync within a scope. `agentId` selects the scope: undefined = all
   *  scopes (legacy), null = parent stream only, a string = that agent's
   *  sub-stream. Seq is monotonic PER SCOPE (see append), so a subscriber to one
   *  scope passes that scope's lastSeq and never sees gaps from another scope. */
  getSinceSeq(
    conversationId: string,
    sinceSeq: number,
    limit?: number,
    agentId?: string | null,
  ): { entries: TranscriptEntryRecord[]; lastSeq: number; gap: boolean }
  /** Backward pagination for infinite scrollback: the `limit` entries with
   *  seq < beforeSeq, returned OLDEST-first (prepend-ready). `oldestSeq` is the
   *  smallest seq returned (the cursor for the next older page); `hasMore` is
   *  true when entries older than `oldestSeq` still exist. `agentId` scopes the
   *  page (undefined = all, null = parent, string = that agent's sub-stream). */
  getBeforeSeq(
    conversationId: string,
    beforeSeq: number,
    limit: number,
    agentId?: string | null,
  ): { entries: TranscriptEntryRecord[]; oldestSeq: number; hasMore: boolean }
  getLastSeq(conversationId: string): number
  /** True when `(conversationId, uuid)` is already stored. The durable arm of
   *  replay dedup: `append` already refuses the row via
   *  `UNIQUE(conversation_id, uuid)`, but a caller that wants to skip the
   *  seq-stamping + broadcast that surrounds the append needs to ask FIRST.
   *  Scope-agnostic -- uuid is unique per conversation across all scopes. */
  hasUuid(conversationId: string, uuid: string): boolean
  find(conversationId: string, filter: TranscriptFilter): TranscriptEntryRecord[]
  search(query: string, opts?: SearchOpts): SearchHit[]
  /** Query-less listing, newest-first. The answer to "what did I say lately?" --
   *  a question FTS cannot express, because it has no search term. Same hit shape
   *  as `search()` so every caller and formatter downstream is unchanged; `rank`
   *  is 0 (nothing was ranked) and `snippet` is a leading preview of the content
   *  rather than a match window. */
  browse(opts?: BrowseOpts): SearchHit[]
  getWindow(conversationId: string, opts: WindowOpts): TranscriptEntryRecord[]
  count(conversationId: string, agentId?: string | null): number
  pruneOlderThan(cutoffMs: number): number
  /** Delete every transcript entry for a conversation. Returns rows removed.
   *  Used by removeConversation to cascade-delete on intentional deletion so
   *  no orphan transcript_entries are left behind. */
  deleteForConversation(conversationId: string): number
  /** Inspect FTS index health -- doc counts, completeness, conversation breadth. */
  getIndexStats(): SearchIndexStats
  /** Drop and rebuild the FTS index from transcript_entries. Memory driver no-ops. */
  rebuildIndex(): RebuildResult
}

/** What `TranscriptStore.append` decided for one input entry. `inserted: false`
 *  means the uuid was already stored -- `seq` is then the existing row's seq,
 *  so a caller can still stamp + route the entry correctly without duplicating
 *  it (the replay case). */
export interface TranscriptAppendResult {
  uuid: string
  seq: number
  inserted: boolean
}

export interface TranscriptEntryInput {
  type: string
  subtype?: string
  agentId?: string
  uuid: string
  content: Record<string, unknown>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Events (hook events)
// ---------------------------------------------------------------------------

export interface EventRecord {
  id: number
  conversationId: string
  type: string
  data?: Record<string, unknown>
  createdAt: number
}

export interface EventStore {
  append(conversationId: string, event: EventInput): void
  getForConversation(
    conversationId: string,
    opts?: { types?: string[]; limit?: number; afterId?: number },
  ): EventRecord[]
  pruneOlderThan(cutoffMs: number): number
  /** Delete every event for a conversation. Returns rows removed. Cascade
   *  partner to TranscriptStore.deleteForConversation. */
  deleteForConversation(conversationId: string): number
}

export interface EventInput {
  type: string
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Key-Value (replaces all small JSON config files)
// ---------------------------------------------------------------------------

export interface KVStore {
  get<T = unknown>(key: string): T | null
  set<T = unknown>(key: string, value: T): void
  delete(key: string): boolean
  keys(prefix?: string): string[]
}

// ---------------------------------------------------------------------------
// Messages (offline queue + inter-conversation log)
// ---------------------------------------------------------------------------

export interface EnqueueMessage {
  fromScope: string
  toScope: string
  fromConversationId?: string
  fromName?: string
  targetName?: string
  content: string
  intent?: string
  conversationId?: string
  expiresAt: number
}

export interface QueuedMessage {
  id: number
  fromScope: string
  toScope: string
  fromConversationId?: string
  fromName?: string
  targetName?: string
  content: string
  intent?: string
  conversationId?: string
  createdAt: number
}

export interface MessageLogEntry {
  id?: number
  fromScope: string
  toScope: string
  fromConversationId?: string
  toConversationId?: string
  fromName?: string
  toName?: string
  content?: string
  intent?: string
  conversationId?: string
  fullLength?: number
  createdAt: number
}

export interface MessageStore {
  enqueue(msg: EnqueueMessage): void
  dequeueFor(scope: string, targetName?: string): QueuedMessage[]
  /** Drop the single oldest non-expired message for a target scope. O(1) vs dequeueFor+re-enqueue. */
  dropOldest(scope: string): void
  countFor(scope: string): number
  log(entry: MessageLogEntry): void
  queryLog(opts?: {
    scope?: string
    conversationId?: string
    limit?: number
    afterId?: number
    before?: number
  }): MessageLogEntry[]
  purgeLog(scopeA: string, scopeB: string): number
  compactLog(retentionMs: number, maxEntries: number): number
  pruneExpired(): number
}

// ---------------------------------------------------------------------------
// Shares (conversation sharing via token)
// ---------------------------------------------------------------------------

export interface ShareCreate {
  token: string
  conversationId: string
  permissions: Record<string, boolean>
  expiresAt: number
}

export interface ShareRecord {
  token: string
  conversationId: string
  permissions: Record<string, boolean>
  createdAt: number
  expiresAt: number
  viewerCount: number
}

export interface ShareStore {
  create(share: ShareCreate): ShareRecord
  get(token: string): ShareRecord | null
  getForConversation(conversationId: string): ShareRecord[]
  incrementViewerCount(token: string): void
  delete(token: string): boolean
  deleteExpired(): number
}

// ---------------------------------------------------------------------------
// Address Book (per-scope routing slugs)
// ---------------------------------------------------------------------------

export interface AddressEntry {
  ownerScope: string
  slug: string
  targetScope: string
  createdAt: number
  lastUsed?: number
}

export interface AddressBookStore {
  resolve(ownerScope: string, slug: string): string | null
  set(ownerScope: string, slug: string, targetScope: string): void
  delete(ownerScope: string, slug: string): boolean
  listForScope(ownerScope: string): AddressEntry[]
  findByTarget(targetScope: string): AddressEntry[]
}

// ---------------------------------------------------------------------------
// Scope Links (inter-project trust)
// ---------------------------------------------------------------------------

export type LinkStatus = 'active' | 'pending' | 'blocked'

export interface ScopeLink {
  scopeA: string
  scopeB: string
  status: LinkStatus
  createdAt: number
}

export interface ScopeLinkStore {
  link(scopeA: string, scopeB: string): void
  unlink(scopeA: string, scopeB: string): void
  getStatus(scopeA: string, scopeB: string): LinkStatus | null
  setStatus(scopeA: string, scopeB: string, status: LinkStatus): void
  listLinksFor(scope: string): ScopeLink[]
}

// ---------------------------------------------------------------------------
// Tasks (per-conversation task tracking)
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string
  conversationId: string
  /** 'todo' | 'project' | future kinds. Free string so the store stays neutral. */
  kind: string
  status: string
  /** Short label / subject. Stored in the `name` column for legacy reasons. */
  name?: string
  description?: string
  priority?: number
  orderIndex?: number
  blockedBy?: string[]
  blocks?: string[]
  owner?: string
  /** Catch-all JSON for kind-specific extras. */
  data?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
  completedAt?: number
  /** Non-null = the task has been archived (no longer in the active list). */
  archivedAt?: number
}

export interface TaskQuery {
  kind?: string
  /** true = archived only, false = active only, undefined = both */
  archived?: boolean
  /** archived_at >= since (ms epoch) */
  archivedSince?: number
  limit?: number
}

export interface TaskStore {
  upsert(conversationId: string, task: TaskRecord): void
  getForConversation(conversationId: string, query?: TaskQuery): TaskRecord[]
  delete(conversationId: string, taskId: string): boolean
  deleteForConversation(conversationId: string): number
  /** Delete archived tasks where archived_at < cutoffMs. Returns rows deleted. */
  pruneArchivedBefore(cutoffMs: number): number
}

// ---------------------------------------------------------------------------
// Cost (per-turn token/cost records + hourly rollups, replaces cost-data.db)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  timestamp: number
  conversationId: string
  projectUri: string
  account: string
  orgId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  exactCost: boolean
  /** Sentinel ID (snt_...) hosting the conversation. Empty when unknown
   *  (e.g. legacy turns recorded before Phase 5). */
  sentinelId?: string
  /** Resolved sentinel-profile name (URI userinfo). Defaults to 'default'
   *  when the conversation has no explicit profile in its URI. */
  profile?: string
}

export interface HourlyRow {
  hour: string
  account: string
  model: string
  projectUri: string
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  sentinelId?: string
  profile?: string
}

export interface ProfileBreakdownRow {
  /** Sentinel ID (snt_...) -- empty for legacy turns predating Phase 5. */
  sentinelId: string
  /** Resolved profile name; 'default' for the implicit / no-profile case. */
  profile: string
  costUsd: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface CostSummary {
  period: string
  totalCostUsd: number
  totalTurns: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  topProjects: Array<{ projectUri: string; costUsd: number; turns: number }>
  topModels: Array<{ model: string; costUsd: number; turns: number }>
  /** Per-(sentinelId, profile) breakdown of cost+turns over the period. */
  profiles: ProfileBreakdownRow[]
}

export interface CumulativeTurnInput {
  timestamp: number
  conversationId: string
  projectUri: string
  account: string
  orgId: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCostUsd: number
  exactCost: boolean
  sentinelId?: string
  profile?: string
}

export interface TurnFilter {
  from?: number
  to?: number
  account?: string
  model?: string
  projectUri?: string
  sentinelId?: string
  profile?: string
  limit?: number
  offset?: number
}

export interface HourlyFilter {
  from?: number
  to?: number
  account?: string
  model?: string
  projectUri?: string
  sentinelId?: string
  profile?: string
  groupBy?: 'hour' | 'day'
}

export interface ProfileBreakdownFilter {
  from?: number
  to?: number
  sentinelId?: string
}

/**
 * The narrowest projection of a turn that a DAY-BUCKETED read needs: when it
 * happened, how big it was, what it cost, and whether that cost was measured.
 *
 * Its own read rather than `queryTurns` because that one is a PAGED list capped
 * at 1000 rows -- a month of this fleet is several thousand, so a caller that
 * needs all of them either loops or silently truncates the oldest end of a
 * chart. This returns the whole window in one pass over `idx_turns_timestamp`,
 * carrying four numbers per row instead of fourteen columns of strings.
 */
export interface TurnActivityRow {
  timestamp: number
  /** input + output + cache read + cache write, summed in the driver. */
  tokens: number
  costUsd: number
  /** True when the agent host filed a real cost; false when it was priced from
   *  tokens. An estimated number is never rendered as a measured one, and this
   *  is the flag that makes that enforceable downstream. */
  exactCost: boolean
}

export type CostPeriod = '24h' | '7d' | '30d'

// ---------------------------------------------------------------------------
// Token samples (per-MESSAGE raw token usage time-series, for the live flow bar)
// ---------------------------------------------------------------------------

export interface TokenSampleInput {
  /** Assistant-message uuid -- dedup key so isInitial re-reads + backfill
   *  never double-count. (conversation_id, uuid) is UNIQUE. */
  uuid: string
  timestamp: number
  conversationId: string
  /** Sentinel ID (snt_...) hosting the conversation. Empty when unknown. */
  sentinelId?: string
  /** Resolved sentinel-profile name. 'default' when none. */
  profile?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Real 5m-TTL portion of cacheWriteTokens. 0 on pre-split rows. */
  cacheWrite5mTokens: number
  /** Real 1h-TTL portion of cacheWriteTokens. 0 on pre-split rows. */
  cacheWrite1hTokens: number
}

export interface TokenBucketFilter {
  from: number
  to: number
  /** Bucket width in ms. Rows are floored into [floor(ts/bucketMs)*bucketMs]. */
  bucketMs: number
  /** 'global' = one aggregate series; 'profile' = one series per (sentinelId, profile). */
  groupBy?: 'global' | 'profile'
  sentinelId?: string
  profile?: string
  /** Restrict to a single conversation's samples (per-conversation time-series). */
  conversationId?: string
}

export interface TokenBucket {
  /** Bucket start (ms, aligned to bucketMs). */
  bucketStart: number
  /** '' in global mode; the sentinel id in profile mode. */
  sentinelId: string
  /** '' in global mode; the profile name in profile mode. */
  profile: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Real 5m-TTL portion of cacheWriteTokens summed over the bucket. */
  cacheWrite5mTokens: number
  /** Real 1h-TTL portion of cacheWriteTokens summed over the bucket. */
  cacheWrite1hTokens: number
  /** Number of per-message samples folded into this bucket. */
  samples: number
}

export interface TokenStore {
  /** Record one per-message sample. INSERT OR IGNORE on (conversation_id, uuid).
   *  Returns true if a NEW row was inserted, false if it was a duplicate -- the
   *  caller broadcasts only newly-inserted samples so isInitial re-reads never
   *  replay history as live. */
  recordSample(sample: TokenSampleInput): boolean
  /** Bucketed aggregation for the flow chart (global series or per-profile series). */
  queryBuckets(filter: TokenBucketFilter): TokenBucket[]
  /** Delete samples older than cutoffMs. Returns rows deleted. */
  pruneOlderThan(cutoffMs: number): number
  /**
   * One-shot backfill from assistant transcript_entries since `sinceMs`, so the
   * widget shows recent history on first deploy instead of an empty chart.
   * Idempotent (INSERT OR IGNORE on uuid). sentinel/profile are attributed from
   * the most recent `turns` row per conversation; conversations with no cost
   * turns fall back to ''/'default' (global view unaffected). Returns rows
   * inserted. Memory driver has no transcript_entries -> returns 0.
   */
  backfillFromTranscripts(sinceMs: number): number
}

export interface CostStore {
  /** Record a turn with explicit per-turn deltas (caller computed the diff). */
  recordTurn(record: TurnRecord): void
  /**
   * Record a turn from cumulative session totals. The driver tracks per-conversation
   * snapshots internally and stores the delta. Returns true if a turn was
   * recorded, false if no delta was detected (duplicate/noop).
   */
  recordTurnFromCumulatives(params: CumulativeTurnInput): boolean
  queryTurns(filter: TurnFilter): { rows: TurnRecord[]; total: number }
  queryHourly(filter: HourlyFilter): HourlyRow[]
  querySummary(period: CostPeriod): CostSummary
  /**
   * Per-(sentinelId, profile) breakdown over [from, to] (defaults to last 30d).
   * Profile names can collide across sentinels (`work@default` vs `work@beast`
   * are different accounts) -- the (sentinelId, profile) tuple is the key.
   * Legacy turns predating Phase 5 bucket under sentinelId='' / profile='default'.
   */
  queryProfileBreakdown(filter?: ProfileBreakdownFilter): ProfileBreakdownRow[]
  /**
   * Every turn in [from, to], oldest first, as the four numbers a day-bucketed
   * fold needs. Unpaged on purpose -- see `TurnActivityRow`.
   *
   * NOT bucketed in SQL: SQLite has no IANA timezone database, so it can group
   * by UTC day or by a fixed offset and nothing else. The caller owns the
   * projection into the viewer's calendar.
   */
  queryTurnActivity(from: number, to: number): TurnActivityRow[]
  /** Delete turns + hourly rows older than cutoffMs. Returns counts deleted. */
  pruneOlderThan(cutoffMs: number): { turns: number; hourly: number }
}

// ---------------------------------------------------------------------------
// StoreDriver -- top-level composition
// ---------------------------------------------------------------------------

export interface StoreConfig {
  type: 'sqlite' | 'memory'
  dataDir?: string
  filename?: string
}

// ---------------------------------------------------------------------------
// Scheduled tasks (cron-triggered spawns + their run history)
// ---------------------------------------------------------------------------

export interface ScheduledTaskQuery {
  /** Restrict to one project (exact `projectUri` match). */
  projectUri?: string
  /** Only schedules armed to fire -- what the engine tick reads every minute. */
  enabledOnly?: boolean
}

export interface ScheduledTaskStore {
  upsert(task: ScheduledTask): void
  get(id: string): ScheduledTask | null
  list(query?: ScheduledTaskQuery): ScheduledTask[]
  delete(id: string): boolean

  /** Append one firing to the history. */
  addRun(run: ScheduledRun): void
  /** Most recent first. */
  listRuns(scheduleId: string, limit?: number): ScheduledRun[]
  getRun(runId: string): ScheduledRun | null
  /** Backfill the outcome once the spawned conversation ends. */
  finishRun(runId: string, endedAt: number, endStatus: string): boolean
  /** Trim history: keep at most `keepPerSchedule` per schedule, drop anything older than `cutoffMs`. */
  pruneRuns(keepPerSchedule: number, cutoffMs: number): number
}

export interface StoreDriver {
  readonly conversations: ConversationStore
  readonly transcripts: TranscriptStore
  readonly events: EventStore
  readonly kv: KVStore
  readonly messages: MessageStore
  readonly shares: ShareStore
  readonly addressBook: AddressBookStore
  readonly scopeLinks: ScopeLinkStore
  readonly tasks: TaskStore
  readonly scheduledTasks: ScheduledTaskStore
  readonly costs: CostStore
  readonly tokens: TokenStore

  init(): void
  close(): void
  compact(): void
}

/**
 * Sheaf builder -- pure read-side aggregation.
 *
 * Pulls conversations active in the [windowStart, windowEnd] window, sums
 * window-bounded turns per conversation, attaches termination metadata, and
 * shapes the result into a spawn-forest-per-project response.
 *
 * No new persistence, no wire emissions. Caller (route) handles auth.
 *
 * See `.claude/docs/plan-sheaf.md`.
 */

import { extractProjectLabel, normalizeProjectUri, projectIdentityKey } from '../../shared/project-uri'
import type { Conversation } from '../../shared/protocol'
import type {
  SheafCost,
  SheafNode,
  SheafProject,
  SheafResponse,
  SheafStatus,
  SheafTokens,
  SheafWorktreeSubtotal,
} from '../../shared/sheaf-types'
import { detectWorktreeName } from '../../shared/worktree-detect'
import type { ConversationStore as BrokerConversationStore } from '../conversation-store'
import type { ConversationRecord, StoreDriver, TurnRecord } from '../store/types'
import type { TerminationLog, TerminationRecord } from '../termination-log'

export interface BuildSheafOpts {
  store: StoreDriver
  conversationStore: BrokerConversationStore
  terminationLog?: TerminationLog
  windowH: number
  /** Override "now" -- tests inject. Defaults to Date.now(). */
  now?: number
}

interface ConvCostRollup {
  tokens: SheafTokens
  cost: SheafCost
  /** model -> total cost contributed. Highest wins. */
  modelTotals: Map<string, number>
}

// ─────────────────────────────────────────────────────────────────────
// Window pull
// ─────────────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
function inWindow(rec: ConversationRecord, windowStart: number): boolean {
  if (rec.createdAt >= windowStart) return true
  if ((rec.lastActivity ?? 0) >= windowStart) return true
  if ((rec.endedAt ?? 0) >= windowStart) return true
  return false
}

// fallow-ignore-next-line complexity
function pullConversationsInWindow(store: StoreDriver, windowStart: number): ConversationRecord[] {
  // `list` returns summaries (no meta). Fetch full records for the ones
  // touching the window. The window pre-filter keeps the per-row .get() fan-out
  // bounded by daily activity, not by total history.
  const summaries = store.conversations.list({ limit: 50_000 })
  const records: ConversationRecord[] = []
  for (const s of summaries) {
    // Quick reject via summary fields before paying for the full get().
    const surfaceLastActivity = s.lastActivity ?? 0
    const surfaceEndedAt = s.endedAt ?? 0
    if (s.createdAt < windowStart && surfaceLastActivity < windowStart && surfaceEndedAt < windowStart) continue
    const rec = store.conversations.get(s.id)
    if (rec && inWindow(rec, windowStart)) records.push(rec)
  }
  return records
}

// ─────────────────────────────────────────────────────────────────────
// Cost / token rollup
// ─────────────────────────────────────────────────────────────────────

function emptyRollup(): ConvCostRollup {
  return {
    tokens: { input: 0, output: 0, cache: 0 },
    cost: { amount: 0, estimated: false },
    modelTotals: new Map(),
  }
}

function addTurnTo(rollup: ConvCostRollup, t: TurnRecord): void {
  rollup.tokens.input += t.inputTokens
  rollup.tokens.output += t.outputTokens
  rollup.tokens.cache += t.cacheReadTokens + t.cacheWriteTokens
  rollup.cost.amount += t.costUsd
  if (!t.exactCost) rollup.cost.estimated = true
  if (t.model) {
    rollup.modelTotals.set(t.model, (rollup.modelTotals.get(t.model) ?? 0) + t.costUsd)
  }
}

// fallow-ignore-next-line complexity
function rollupTurns(store: StoreDriver, idSet: Set<string>, from: number, to: number): Map<string, ConvCostRollup> {
  // CostStore.queryTurns paginates with a hard cap of 1000 per call. Loop
  // through pages until we exhaust the window so a busy day doesn't get
  // silently truncated.
  const acc = new Map<string, ConvCostRollup>()
  const PAGE = 1000
  let offset = 0
  // Safety cap: 100 pages == 100k turns in 24h. Far above realistic fleet load.
  for (let i = 0; i < 100; i++) {
    const { rows } = store.costs.queryTurns({ from, to, limit: PAGE, offset })
    for (const r of rows) {
      if (!idSet.has(r.conversationId)) continue
      let rollup = acc.get(r.conversationId)
      if (!rollup) {
        rollup = emptyRollup()
        acc.set(r.conversationId, rollup)
      }
      addTurnTo(rollup, r)
    }
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return acc
}

// fallow-ignore-next-line complexity
function pickTopModel(rollup: ConvCostRollup | undefined, fallback: string | undefined): string | null {
  if (!rollup || rollup.modelTotals.size === 0) return fallback ?? null
  let best: string | null = null
  let bestCost = -1
  for (const [model, cost] of rollup.modelTotals) {
    if (cost > bestCost) {
      bestCost = cost
      best = model
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────
// Status + outcome
// ─────────────────────────────────────────────────────────────────────

// Mapping mirrors `TerminationSource` in src/shared/protocol.ts. Sources NOT
// listed here fall through to status 'ended' with the raw source as the phrase.
const TERMINATION_SOURCE_REASONS: Record<string, { status: SheafStatus; phrase: string }> = {
  'dashboard-context-menu': { status: 'killed', phrase: 'killed via dashboard' },
  'dashboard-terminate-dialog': { status: 'killed', phrase: 'killed via dashboard' },
  'dashboard-launch-toast': { status: 'killed', phrase: 'launch cancelled' },
  'dashboard-other': { status: 'killed', phrase: 'killed via dashboard' },
  'inter-conversation-restart': { status: 'killed', phrase: 'restarted by peer' },
  'mcp-exit-session': { status: 'ended', phrase: 'agent self-exit' },
  'headless-input': { status: 'ended', phrase: 'user typed /exit' },
  'cc-exit-normal': { status: 'ended', phrase: 'clean exit' },
  'cc-exit-crash': { status: 'crashed', phrase: 'CC crashed' },
  'ws-close': { status: 'ended', phrase: 'agent host disconnected' },
  'reaper-phantom': { status: 'killed', phrase: 'reaped (idle)' },
  'daemon-job-gone': { status: 'ended', phrase: 'daemon job gone' },
  'sentinel-kill': { status: 'killed', phrase: 'sentinel killed' },
  unknown: { status: 'ended', phrase: 'ended (unknown)' },
}

// fallow-ignore-next-line complexity
function statusFor(
  rec: ConversationRecord,
  live: Conversation | undefined,
  termination: TerminationRecord | undefined,
): SheafStatus {
  // Live in-memory wins -- it knows about socket attachment.
  if (live) {
    if (live.status === 'active') return 'running'
    if (live.status === 'idle') return 'idle'
  }
  if (termination) {
    const mapped = TERMINATION_SOURCE_REASONS[termination.source]
    if (mapped) return mapped.status
    return 'ended'
  }
  if (rec.endedAt) return 'ended'
  if (rec.status === 'active') return 'idle' // alive in DB, no live record = stale tracker
  return 'ended'
}

function formatAgo(deltaMs: number): string {
  if (deltaMs < 60_000) return `${Math.max(1, Math.floor(deltaMs / 1000))}s ago`
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`
  return `${Math.floor(deltaMs / 86_400_000)}d ago`
}

// fallow-ignore-next-line complexity
function outcomeFromTermination(termination: TerminationRecord): { outcomeLine: string; terminationReason: string } {
  const phrase = TERMINATION_SOURCE_REASONS[termination.source]?.phrase ?? termination.source
  const initiator = termination.initiator ? ` (by ${termination.initiator})` : ''
  const detailNote =
    termination.detail && typeof termination.detail === 'object'
      ? extractDetailNote(termination.detail as Record<string, unknown>)
      : null
  const outcomeLine = detailNote ? `${phrase}${initiator}: ${detailNote}` : `${phrase}${initiator}`
  return { outcomeLine, terminationReason: phrase }
}

// fallow-ignore-next-line complexity
function outcomeFromStatus(rec: ConversationRecord, status: SheafStatus, now: number): string {
  if (status === 'running' || status === 'idle') {
    const lastActivity = rec.lastActivity ?? rec.createdAt
    return `${status} - last activity ${formatAgo(now - lastActivity)}`
  }
  if (rec.endedAt) return `ended ${formatAgo(now - rec.endedAt)}`
  return status
}

function outcomeFor(
  rec: ConversationRecord,
  status: SheafStatus,
  termination: TerminationRecord | undefined,
  now: number,
): { outcomeLine: string; terminationReason: string | null } {
  if (termination) return outcomeFromTermination(termination)
  return { outcomeLine: outcomeFromStatus(rec, status, now), terminationReason: null }
}

// fallow-ignore-next-line complexity
function extractDetailNote(detail: Record<string, unknown>): string | null {
  const candidates = ['note', 'reason', 'message', 'detail']
  for (const key of candidates) {
    const v = detail[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      const trimmed = v.trim()
      return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────
// Node assembly
// ─────────────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
function resolveCurrentPath(rec: ConversationRecord, live: Conversation | undefined): string | undefined {
  if (live?.currentPath) return live.currentPath
  const fromMeta = rec.meta?.currentPath
  return typeof fromMeta === 'string' ? fromMeta : undefined
}

// fallow-ignore-next-line complexity
function buildLeafNode(
  rec: ConversationRecord,
  live: Conversation | undefined,
  rollup: ConvCostRollup | undefined,
  termination: TerminationRecord | undefined,
  now: number,
): SheafNode {
  const status = statusFor(rec, live, termination)
  const startedAt = rec.createdAt
  const endedAt = rec.endedAt ?? null
  const durationMs = (endedAt ?? now) - startedAt
  const tokens: SheafTokens = rollup?.tokens ?? { input: 0, output: 0, cache: 0 }
  const cost: SheafCost = rollup?.cost ?? { amount: 0, estimated: false }
  const model = pickTopModel(rollup, rec.model)
  const worktreeName = detectWorktreeName(resolveCurrentPath(rec, live))
  const { outcomeLine, terminationReason } = outcomeFor(rec, status, termination, now)

  return {
    id: rec.id,
    title: rec.title || '(untitled)',
    status,
    scope: rec.scope,
    startedAt,
    endedAt,
    durationMs,
    tokens,
    cost,
    model,
    worktreeName,
    commits: 0, // phase 3
    outcomeLine,
    terminationReason,
    children: [],
    treeTotals: {
      tokens: { ...tokens },
      cost: { ...cost },
      durationWallMs: durationMs,
      convCount: 1,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Forest + rollups
// ─────────────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
function buildForest(records: ConversationRecord[], nodesById: Map<string, SheafNode>): SheafNode[] {
  // Attach each node to its parent if the parent is also in the window;
  // otherwise it becomes a root. Spawn lineage's `root_conversation_id` is NOT
  // used as the grouping key here because mid-tree roots (parent ended outside
  // the window) are still valid roots from the window's perspective.
  const roots: SheafNode[] = []
  for (const rec of records) {
    const node = nodesById.get(rec.id)
    if (!node) continue
    const parentId = rec.parentConversationId
    if (parentId && nodesById.has(parentId)) {
      nodesById.get(parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  // Sort siblings (and roots) by start time.
  const sortBySpawnTime = (a: SheafNode, b: SheafNode): number => a.startedAt - b.startedAt
  function sortRecursive(node: SheafNode): void {
    node.children.sort(sortBySpawnTime)
    for (const child of node.children) sortRecursive(child)
  }
  roots.sort(sortBySpawnTime)
  for (const root of roots) sortRecursive(root)
  return roots
}

// fallow-ignore-next-line complexity
function rollupTree(node: SheafNode): void {
  for (const child of node.children) rollupTree(child)
  let minStart = node.startedAt
  let maxEnd = node.endedAt ?? node.startedAt + node.durationMs
  let convCount = 1
  const tokens: SheafTokens = { ...node.tokens }
  const cost: SheafCost = { amount: node.cost.amount, estimated: node.cost.estimated }
  for (const child of node.children) {
    tokens.input += child.treeTotals.tokens.input
    tokens.output += child.treeTotals.tokens.output
    tokens.cache += child.treeTotals.tokens.cache
    cost.amount += child.treeTotals.cost.amount
    if (child.treeTotals.cost.estimated) cost.estimated = true
    convCount += child.treeTotals.convCount
    if (child.startedAt < minStart) minStart = child.startedAt
    const childEnd = child.endedAt ?? child.startedAt + child.treeTotals.durationWallMs
    if (childEnd > maxEnd) maxEnd = childEnd
  }
  node.treeTotals = {
    tokens,
    cost,
    durationWallMs: maxEnd - minStart,
    convCount,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Project grouping
// ─────────────────────────────────────────────────────────────────────

function groupByProject(roots: SheafNode[], allNodes: SheafNode[]): SheafProject[] {
  // A tree belongs to the project of its ROOT node. Sub-tree members may have
  // different scope (rare but possible if a spawn changes cwd); for the
  // window-overview they roll up under the root's bucket.
  const buckets = new Map<string, { roots: SheafNode[]; members: SheafNode[] }>()
  function visit(node: SheafNode, bucketKey: string, members: SheafNode[]): void {
    members.push(node)
    for (const child of node.children) visit(child, bucketKey, members)
  }
  for (const root of roots) {
    const key = projectIdentityKey(root.scope)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { roots: [], members: [] }
      buckets.set(key, bucket)
    }
    bucket.roots.push(root)
    visit(root, key, bucket.members)
  }
  // allNodes is unused for bucketing but kept in the signature for symmetry
  // with future changes (e.g. ungrouped members from disconnected windows).
  void allNodes
  const projects: SheafProject[] = []
  for (const [projectUri, bucket] of buckets) {
    projects.push(buildProjectBucket(projectUri, bucket.roots, bucket.members))
  }
  return projects
}

// fallow-ignore-next-line complexity
function buildProjectBucket(projectUri: string, roots: SheafNode[], members: SheafNode[]): SheafProject {
  const worktreesByName = new Map<string | null, SheafWorktreeSubtotal>()
  for (const node of members) {
    const key = node.worktreeName
    let entry = worktreesByName.get(key)
    if (!entry) {
      entry = {
        name: key,
        convCount: 0,
        tokens: { input: 0, output: 0, cache: 0 },
        cost: { amount: 0, estimated: false },
      }
      worktreesByName.set(key, entry)
    }
    entry.convCount++
    entry.tokens.input += node.tokens.input
    entry.tokens.output += node.tokens.output
    entry.tokens.cache += node.tokens.cache
    entry.cost.amount += node.cost.amount
    if (node.cost.estimated) entry.cost.estimated = true
  }
  // Sort: "(main)" first, then worktrees alphabetically.
  const worktrees = Array.from(worktreesByName.values()).sort((a, b) => {
    if (a.name === null) return -1
    if (b.name === null) return 1
    return a.name.localeCompare(b.name)
  })

  const totals = {
    tokens: { input: 0, output: 0, cache: 0 } as SheafTokens,
    cost: { amount: 0, estimated: false } as SheafCost,
    convCount: 0,
    treeCount: roots.length,
  }
  for (const root of roots) {
    totals.tokens.input += root.treeTotals.tokens.input
    totals.tokens.output += root.treeTotals.tokens.output
    totals.tokens.cache += root.treeTotals.tokens.cache
    totals.cost.amount += root.treeTotals.cost.amount
    if (root.treeTotals.cost.estimated) totals.cost.estimated = true
    totals.convCount += root.treeTotals.convCount
  }
  return {
    projectUri,
    label: extractProjectLabel(projectUri),
    worktrees,
    forest: roots,
    totals,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
function pullTerminations(
  terminationLog: TerminationLog | undefined,
  idSet: Set<string>,
  windowH: number,
): Map<string, TerminationRecord> {
  const result = new Map<string, TerminationRecord>()
  if (!terminationLog) return result
  const days = Math.max(1, Math.ceil(windowH / 24) + 1)
  for (const t of terminationLog.query({ days, limit: 50_000 })) {
    if (idSet.has(t.conversationId) && !result.has(t.conversationId)) {
      // query() returns newest-first -- first hit per id is the latest.
      result.set(t.conversationId, t)
    }
  }
  return result
}

function pullLiveSnapshot(conversationStore: BrokerConversationStore): Map<string, Conversation> {
  const map = new Map<string, Conversation>()
  for (const c of conversationStore.getAllConversations()) map.set(c.id, c)
  return map
}

function emptySheaf(windowH: number, windowStart: number, windowEnd: number, generatedAt: number): SheafResponse {
  return {
    windowH,
    windowStart,
    windowEnd,
    generatedAt,
    totals: {
      projects: 0,
      conversations: 0,
      trees: 0,
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
    },
    projects: [],
  }
}

function sumProjectTotals(projects: SheafProject[]): { tokens: SheafTokens; cost: SheafCost } {
  const tokens: SheafTokens = { input: 0, output: 0, cache: 0 }
  const cost: SheafCost = { amount: 0, estimated: false }
  for (const p of projects) {
    tokens.input += p.totals.tokens.input
    tokens.output += p.totals.tokens.output
    tokens.cache += p.totals.tokens.cache
    cost.amount += p.totals.cost.amount
    if (p.totals.cost.estimated) cost.estimated = true
  }
  return { tokens, cost }
}

function buildAllNodes(
  records: ConversationRecord[],
  liveByConvId: Map<string, Conversation>,
  rollups: Map<string, ConvCostRollup>,
  terminations: Map<string, TerminationRecord>,
  now: number,
): Map<string, SheafNode> {
  const nodesById = new Map<string, SheafNode>()
  for (const rec of records) {
    const node = buildLeafNode(rec, liveByConvId.get(rec.id), rollups.get(rec.id), terminations.get(rec.id), now)
    // Normalize scope so worktree paths bucket with their parent project.
    node.scope = normalizeProjectUri(node.scope)
    nodesById.set(rec.id, node)
  }
  return nodesById
}

// fallow-ignore-next-line complexity
export function buildSheaf(opts: BuildSheafOpts): SheafResponse {
  const now = opts.now ?? Date.now()
  const windowH = Math.max(1, Math.min(168, opts.windowH))
  const windowStart = now - windowH * 60 * 60 * 1000
  const windowEnd = now

  const records = pullConversationsInWindow(opts.store, windowStart)
  if (records.length === 0) return emptySheaf(windowH, windowStart, windowEnd, now)

  const idSet = new Set(records.map(r => r.id))
  const rollups = rollupTurns(opts.store, idSet, windowStart, windowEnd)
  const terminations = pullTerminations(opts.terminationLog, idSet, windowH)
  const liveByConvId = pullLiveSnapshot(opts.conversationStore)

  const nodesById = buildAllNodes(records, liveByConvId, rollups, terminations, now)
  const roots = buildForest(records, nodesById)
  for (const root of roots) rollupTree(root)

  const projects = groupByProject(roots, Array.from(nodesById.values()))
  projects.sort((a, b) => b.totals.cost.amount - a.totals.cost.amount)

  const projectTotals = sumProjectTotals(projects)
  return {
    windowH,
    windowStart,
    windowEnd,
    generatedAt: now,
    totals: {
      projects: projects.length,
      conversations: nodesById.size,
      trees: roots.length,
      tokens: projectTotals.tokens,
      cost: projectTotals.cost,
    },
    projects,
  }
}

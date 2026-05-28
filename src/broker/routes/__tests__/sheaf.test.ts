/**
 * Tests for /api/sheaf -- 24/48h fleet overview.
 *
 * Verifies: auth, window filtering, project bucketing, spawn-forest tree
 * rollup, worktree sub-tag detection, cost-estimated flag propagation,
 * termination outcome lines.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SheafResponse } from '../../../shared/sheaf-types'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver } from '../../store/types'
import { createTerminationLog, type TerminationLog } from '../../termination-log'
import { createRouteHelpers, type RouteHelpers } from '../shared'
import { createSheafRouter } from '../sheaf'

const TEST_SECRET = 'test-secret-sheaf-42'
const NOW = 1_700_000_000_000

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers
let terminationLog: TerminationLog
let cacheDir: string

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)
  cacheDir = mkdtempSync(join(tmpdir(), 'sheaf-test-'))
  terminationLog = createTerminationLog(cacheDir)

  app = new Hono()
  app.route('/', createSheafRouter(store, conversationStore, helpers, terminationLog))
})

// fallow-ignore-next-line complexity
function createConv(
  id: string,
  opts: {
    scope?: string
    title?: string
    createdAt?: number
    endedAt?: number
    lastActivity?: number
    status?: string
    parent?: string
    root?: string
    currentPath?: string
  } = {},
) {
  store.conversations.create({
    id,
    scope: opts.scope ?? 'claude://default/Users/test/proj',
    agentType: 'claude',
    title: opts.title,
    createdAt: opts.createdAt ?? NOW - 60_000,
    parentConversationId: opts.parent,
    rootConversationId: opts.root,
    meta: opts.currentPath ? { currentPath: opts.currentPath } : undefined,
  })
  if (opts.endedAt || opts.lastActivity || opts.status) {
    store.conversations.update(id, {
      status: opts.status,
      endedAt: opts.endedAt,
      lastActivity: opts.lastActivity,
    })
  }
}

// fallow-ignore-next-line complexity
function recordTurn(
  conversationId: string,
  opts: { ts: number; cost?: number; tokens?: number; exact?: boolean; model?: string },
) {
  store.costs.recordTurn({
    timestamp: opts.ts,
    conversationId,
    projectUri: 'claude://default/Users/test/proj',
    account: 'test',
    orgId: 'org',
    model: opts.model ?? 'claude-sonnet-4',
    inputTokens: opts.tokens ?? 100,
    outputTokens: opts.tokens ?? 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: opts.cost ?? 0.1,
    exactCost: opts.exact ?? true,
  })
}

async function fetchSheaf(query = ''): Promise<SheafResponse> {
  const res = await app.request(`/api/sheaf${query}`, { headers: authHeaders() })
  expect(res.status).toBe(200)
  return (await res.json()) as SheafResponse
}

describe('GET /api/sheaf -- auth', () => {
  it('rejects without admin auth', async () => {
    const res = await app.request('/api/sheaf')
    expect(res.status).toBe(403)
  })
})

describe('GET /api/sheaf -- empty', () => {
  it('returns zero totals when fleet is empty', async () => {
    const body = await fetchSheaf()
    expect(body.totals.conversations).toBe(0)
    expect(body.totals.projects).toBe(0)
    expect(body.projects).toEqual([])
    expect(body.windowH).toBe(24)
  })
})

describe('GET /api/sheaf -- window filter', () => {
  it('includes only conversations touching the window', async () => {
    const cutoff = Date.now() - 24 * 3600_000
    createConv('conv_in', {
      createdAt: cutoff + 60_000,
      lastActivity: cutoff + 120_000,
    })
    createConv('conv_old', {
      createdAt: cutoff - 7 * 24 * 3600_000,
      endedAt: cutoff - 6 * 24 * 3600_000,
    })
    const body = await fetchSheaf()
    expect(body.totals.conversations).toBe(1)
    expect(body.projects[0].forest[0].id).toBe('conv_in')
  })

  it('clamps windowH to a sane range', async () => {
    const body = await fetchSheaf('?windowH=-5')
    expect(body.windowH).toBe(24)
  })
})

describe('GET /api/sheaf -- token + cost rollup', () => {
  it('sums turns inside the window per conversation', async () => {
    const now = Date.now()
    createConv('conv_a', { createdAt: now - 3600_000, lastActivity: now - 60_000 })
    recordTurn('conv_a', { ts: now - 1800_000, cost: 0.25, tokens: 1000, exact: true })
    recordTurn('conv_a', { ts: now - 900_000, cost: 0.5, tokens: 500, exact: true })
    // Out of window -- should not roll in.
    recordTurn('conv_a', { ts: now - 48 * 3600_000, cost: 99, tokens: 99_999, exact: true })
    const body = await fetchSheaf()
    const node = body.projects[0].forest[0]
    expect(node.cost.amount).toBeCloseTo(0.75, 5)
    expect(node.cost.estimated).toBe(false)
    expect(node.tokens.input).toBe(1500)
  })

  it('flags estimated cost when ANY turn is estimated', async () => {
    const now = Date.now()
    createConv('conv_a', { createdAt: now - 3600_000, lastActivity: now - 60_000 })
    recordTurn('conv_a', { ts: now - 1800_000, cost: 0.25, exact: true })
    recordTurn('conv_a', { ts: now - 900_000, cost: 0.5, exact: false })
    const body = await fetchSheaf()
    expect(body.projects[0].forest[0].cost.estimated).toBe(true)
  })
})

describe('GET /api/sheaf -- spawn forest', () => {
  it('builds parent-child tree from parent_conversation_id', async () => {
    const now = Date.now()
    createConv('conv_root', { createdAt: now - 3600_000, lastActivity: now - 60_000 })
    createConv('conv_child', {
      createdAt: now - 3000_000,
      lastActivity: now - 60_000,
      parent: 'conv_root',
      root: 'conv_root',
    })
    createConv('conv_grandchild', {
      createdAt: now - 2400_000,
      endedAt: now - 1800_000,
      parent: 'conv_child',
      root: 'conv_root',
    })
    recordTurn('conv_root', { ts: now - 3000_000, cost: 0.1 })
    recordTurn('conv_child', { ts: now - 2700_000, cost: 0.2 })
    recordTurn('conv_grandchild', { ts: now - 2100_000, cost: 0.05 })

    const body = await fetchSheaf()
    const root = body.projects[0].forest[0]
    expect(root.id).toBe('conv_root')
    expect(root.children).toHaveLength(1)
    expect(root.children[0].id).toBe('conv_child')
    expect(root.children[0].children).toHaveLength(1)
    expect(root.children[0].children[0].id).toBe('conv_grandchild')
    // Tree rolls up cost across all three.
    expect(root.treeTotals.cost.amount).toBeCloseTo(0.35, 5)
    expect(root.treeTotals.convCount).toBe(3)
  })

  it('treats mid-tree node as a root when its parent is outside the window', async () => {
    const now = Date.now()
    createConv('conv_orphan_child', {
      createdAt: now - 3600_000,
      lastActivity: now - 60_000,
      parent: 'conv_parent_outside',
      root: 'conv_parent_outside',
    })
    const body = await fetchSheaf()
    expect(body.projects[0].forest).toHaveLength(1)
    expect(body.projects[0].forest[0].id).toBe('conv_orphan_child')
  })
})

describe('GET /api/sheaf -- worktree sub-tag', () => {
  it('tags conversations whose currentPath is in a worktree', async () => {
    const now = Date.now()
    createConv('conv_main', {
      createdAt: now - 3600_000,
      lastActivity: now - 60_000,
      currentPath: '/Users/test/proj',
    })
    createConv('conv_wt', {
      createdAt: now - 3600_000,
      lastActivity: now - 60_000,
      currentPath: '/Users/test/proj/.claude/worktrees/feature-x',
    })
    const body = await fetchSheaf()
    expect(body.projects).toHaveLength(1)
    const proj = body.projects[0]
    expect(new Set(proj.worktrees.map(w => w.name))).toEqual(new Set([null, 'feature-x']))
    const wtNode = proj.forest.find(n => n.id === 'conv_wt')!
    expect(wtNode.worktreeName).toBe('feature-x')
  })
})

describe('GET /api/sheaf -- termination outcome', () => {
  it('reports termination reason as outcome line for ended conversations', async () => {
    const now = Date.now()
    createConv('conv_killed', {
      createdAt: now - 3600_000,
      endedAt: now - 60_000,
    })
    terminationLog.append({
      ts: new Date(now - 60_000).toISOString(),
      conversationId: 'conv_killed',
      source: 'reaper-phantom',
      initiator: 'reaper',
      detail: { note: 'idle 2h' },
    })
    const body = await fetchSheaf()
    const node = body.projects[0].forest[0]
    expect(node.status).toBe('killed')
    expect(node.outcomeLine).toContain('reaped')
    expect(node.outcomeLine).toContain('idle 2h')
    expect(node.terminationReason).toBe('reaped (idle)')
  })
})

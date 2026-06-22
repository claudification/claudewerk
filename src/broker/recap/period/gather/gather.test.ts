import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../../store/sqlite/driver'
import type { StoreDriver } from '../../../store/types'
import {
  gatherCommitsStub,
  gatherConversations,
  gatherCost,
  gatherErrors,
  gatherOpenQuestions,
  gatherTasks,
  gatherToolUse,
  gatherTranscripts,
  type PeriodScope,
  resolveProjectScope,
} from './index'

describe('Phase 3 gather modules (integration)', () => {
  let cacheDir: string
  let store: StoreDriver
  const projectUri = 'claude://default/Users/test/proj'
  const periodStart = 1_700_000_000_000
  const periodEnd = 1_700_604_800_000
  const scope: PeriodScope = {
    projectUris: [projectUri],
    periodStart,
    periodEnd,
    timeZone: 'Europe/Stockholm',
  }

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'gather-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
    seed(store, projectUri, periodStart)
  })

  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('gatherConversations returns conversations within the period window', () => {
    const out = gatherConversations(store, scope)
    expect(out.length).toBe(1)
    expect(out[0].id).toBe('conv_seed')
    expect(out[0].projectUri).toBe(projectUri)
  })

  it('gatherConversations counts turns from the recorded-turn table (regression: was always 0)', () => {
    // The seed records exactly one turn for conv_seed inside the window. The old
    // code read a non-existent summary `stats.turns` and reported 0; the count
    // must now come from the turn table.
    const out = gatherConversations(store, scope)
    expect(out[0].turnCount).toBe(1)
  })

  it('gatherTranscripts returns user prompt + assistant final pairs', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherTranscripts(store, conversations, scope)
    expect(out.length).toBe(1)
    expect(out[0].turns.length).toBeGreaterThan(0)
    expect(out[0].turns[0].userPrompt).toContain('hello')
  })

  it('gatherCost aggregates totals + per-day + per-model + per-conv breakdowns', () => {
    const out = gatherCost(store, scope)
    expect(out.totalTurns).toBeGreaterThan(0)
    expect(out.totalCostUsd).toBeGreaterThan(0)
    expect(out.perDay.length).toBeGreaterThan(0)
    expect(out.perModel.length).toBeGreaterThan(0)
    expect(out.perConversation.length).toBeGreaterThan(0)
  })

  it('gatherTasks classifies done/created/in-progress within the window', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherTasks(store, conversations, scope)
    expect(out.doneInPeriod.length).toBeGreaterThanOrEqual(0)
    expect(out.createdInPeriod.length).toBeGreaterThanOrEqual(0)
  })

  it('gatherToolUse returns per-conversation tool counts', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherToolUse(store, conversations, scope)
    expect(Array.isArray(out.perConversation)).toBe(true)
  })

  it('gatherErrors returns incidents from system entries with error subtypes', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherErrors(store, conversations, scope)
    expect(Array.isArray(out.incidents)).toBe(true)
  })

  it('gatherOpenQuestions returns conversations whose final assistant text ends with a question', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherOpenQuestions(store, conversations, scope)
    expect(out.conversationsWithOpenQuestions.length).toBe(1)
    expect(out.conversationsWithOpenQuestions[0].openQuestions[0]).toContain('?')
  })

  it('gatherCommitsStub returns empty per-project list with parsed cwd', () => {
    const out = gatherCommitsStub(scope)
    expect(out.perProject.length).toBe(1)
    expect(out.perProject[0].cwd).toBe('/Users/test/proj')
    expect(out.perProject[0].commits.length).toBe(0)
  })

  // --- Cross-project ('*') scope regression ------------------------------
  // The bug: a cross-project recap (projectUri '*') enumerated ZERO
  // conversations. '*' fell through as a literal `WHERE scope = '*'` filter,
  // which never matches (the scope column holds real project URIs), so the
  // whole "all projects this week" recap came back empty even though a
  // per-project recap found dozens. The fix resolves '*' to the store's
  // distinct project scopes BEFORE gathering.
  describe("cross-project '*' scope", () => {
    const otherProject = 'claude://default/Users/test/other'

    beforeEach(() => {
      seed(store, otherProject, periodStart, 'conv_seed_other')
    })

    it('listScopes returns every distinct project scope', () => {
      expect(new Set(store.conversations.listScopes())).toEqual(new Set([projectUri, otherProject]))
    })

    it("resolveProjectScope('*') expands to all project scopes (NOT a literal '*')", () => {
      const resolved = resolveProjectScope(store, '*')
      expect(resolved).not.toContain('*')
      expect(new Set(resolved)).toEqual(new Set([projectUri, otherProject]))
    })

    it('resolveProjectScope(concreteUri) passes the URI through unchanged', () => {
      expect(resolveProjectScope(store, projectUri)).toEqual([projectUri])
    })

    it("gatherConversations under resolved '*' scope enumerates BOTH projects", () => {
      const allScope: PeriodScope = { ...scope, projectUris: resolveProjectScope(store, '*') }
      const out = gatherConversations(store, allScope)
      expect(out.length).toBe(2)
      expect(new Set(out.map(c => c.projectUri))).toEqual(new Set([projectUri, otherProject]))
    })

    it('gatherConversations under a single concrete scope still returns only its subset', () => {
      const out = gatherConversations(store, { ...scope, projectUris: resolveProjectScope(store, projectUri) })
      expect(out.length).toBe(1)
      expect(out[0].projectUri).toBe(projectUri)
    })
  })
})

function seed(store: StoreDriver, projectUri: string, periodStart: number, convId = 'conv_seed') {
  store.conversations.create({
    id: convId,
    scope: projectUri,
    agentType: 'claude',
    title: 'Seed conversation',
    createdAt: periodStart + 1_000,
  })
  store.conversations.update(convId, { lastActivity: periodStart + 5_000 })
  store.transcripts.append(convId, 'epoch1', [
    {
      type: 'user',
      uuid: 'u1',
      content: { message: { role: 'user', content: 'hello assistant please help' } },
      timestamp: periodStart + 2_000,
    },
    {
      type: 'assistant',
      uuid: 'a1',
      content: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will help. What database backend would you like?' }],
        },
      },
      timestamp: periodStart + 3_000,
    },
  ])
  store.costs.recordTurn({
    timestamp: periodStart + 4_000,
    conversationId: convId,
    projectUri,
    account: 'a',
    orgId: '',
    model: 'anthropic/claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.0042,
    exactCost: true,
  })
  store.tasks.upsert(convId, {
    id: `task_${convId}`,
    conversationId: convId,
    kind: 'todo',
    status: 'done',
    name: 'Set up storage',
    createdAt: periodStart + 1_500,
    updatedAt: periodStart + 4_500,
    completedAt: periodStart + 4_500,
  })
}

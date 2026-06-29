/**
 * microdiff fitness tests for rclaude state sync.
 *
 * Validates that microdiff produces compact, correct patches for the kinds of
 * state changes that actually happen in the broker -> control panel pipeline.
 * Each test compares patch size vs full-replace size to confirm the diff is
 * worth sending.
 */
import { describe, expect, it } from 'bun:test'
import diff, { type Difference } from 'microdiff'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patchSize(d: Difference[]): number {
  return JSON.stringify(d).length
}

function fullSize(obj: unknown): number {
  return JSON.stringify(obj).length
}

// fallow-ignore-next-line code-duplication
function applyPatch<T extends Record<string, unknown>>(base: T, diffs: Difference[]): T {
  const out = structuredClone(base)
  for (const d of diffs) {
    let target: any = out
    for (let i = 0; i < d.path.length - 1; i++) {
      target = target[d.path[i]]
    }
    const key = d.path[d.path.length - 1]
    if (d.type === 'REMOVE') {
      delete target[key]
    } else {
      target[key] = d.value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Realistic ConversationSummary-shaped fixture
// ---------------------------------------------------------------------------

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv_abc123def456',
    project: 'claude://default/Users/jonas/projects/remote-claude',
    model: 'claude-sonnet-4-6',
    connectionIds: ['conn_a1b2c3d4'],
    startedAt: 1719600000000,
    lastActivity: 1719603600000,
    status: 'active' as const,
    eventCount: 142,
    activeSubagentCount: 2,
    totalSubagentCount: 5,
    subagents: [
      {
        agentId: 'sa_001',
        agentType: 'Explore',
        description: 'Find auth middleware',
        status: 'running' as const,
        startedAt: 1719602000000,
        eventCount: 23,
      },
      {
        agentId: 'sa_002',
        agentType: 'general-purpose',
        description: 'Refactor login flow',
        status: 'stopped' as const,
        startedAt: 1719601000000,
        stoppedAt: 1719602500000,
        eventCount: 87,
      },
    ],
    taskCount: 8,
    pendingTaskCount: 3,
    activeTasks: [
      { id: 'task_1', subject: 'Implement auth middleware' },
      { id: 'task_2', subject: 'Write integration tests' },
    ],
    pendingTasks: [
      { id: 'task_3', subject: 'Deploy to staging' },
      { id: 'task_4', subject: 'Update docs' },
      { id: 'task_5', subject: 'Code review' },
    ],
    completedTaskCount: 3,
    completedTasks: [
      { id: 'task_6', subject: 'Set up project' },
      { id: 'task_7', subject: 'Design schema' },
      { id: 'task_8', subject: 'Create migration' },
    ],
    archivedTaskCount: 0,
    runningBgTaskCount: 1,
    bgTasks: [
      {
        taskId: 'bg_1',
        command: 'bun test --watch',
        description: 'Run test watcher',
        startedAt: 1719601500000,
        status: 'running' as const,
      },
    ],
    monitors: [],
    runningMonitorCount: 0,
    teammates: [],
    effortLevel: 'high',
    permissionMode: 'auto',
    title: 'Auth middleware refactor',
    summary: 'Refactoring the auth middleware to support OAuth tokens',
    tokenUsage: { input: 45000, cacheCreation: 12000, cacheRead: 8000, output: 15000 },
    contextWindow: 200000,
    stats: { totalCostUsd: 0.42, turns: 12 },
    gitBranch: 'feat/auth-middleware',
    backend: 'claude',
    transport: 'claude-headless',
    resolvedProfile: 'default',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('microdiff fitness for rclaude state sync', () => {
  describe('single-field scalar changes', () => {
    it('status flip (the most common update)', () => {
      const prev = makeSummary({ status: 'active' })
      const next = makeSummary({ status: 'idle' })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].path).toEqual(['status'])
      expect(d[0].type).toBe('CHANGE')

      // patch should be dramatically smaller than full object
      const ratio = patchSize(d) / fullSize(next)
      expect(ratio).toBeLessThan(0.1)
    })

    it('lastActivity timestamp bump', () => {
      const prev = makeSummary()
      const next = makeSummary({ lastActivity: prev.lastActivity + 5000 })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].path).toEqual(['lastActivity'])
    })

    it('eventCount increment', () => {
      const prev = makeSummary({ eventCount: 142 })
      const next = makeSummary({ eventCount: 143 })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].path).toEqual(['eventCount'])
    })

    it('title change', () => {
      const prev = makeSummary({ title: 'Old title' })
      const next = makeSummary({ title: 'New title that is quite different' })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].path).toEqual(['title'])
    })
  })

  describe('multi-field changes (typical status + activity combo)', () => {
    it('status + lastActivity + eventCount (the bread-and-butter update)', () => {
      const prev = makeSummary({ status: 'active', lastActivity: 1719603600000, eventCount: 142 })
      const next = makeSummary({ status: 'idle', lastActivity: 1719603605000, eventCount: 145 })
      const d = diff(prev, next)

      expect(d).toHaveLength(3)
      const ratio = patchSize(d) / fullSize(next)
      expect(ratio).toBeLessThan(0.15)
    })

    it('token usage update (nested object, multiple fields)', () => {
      const prev = makeSummary({ tokenUsage: { input: 45000, cacheCreation: 12000, cacheRead: 8000, output: 15000 } })
      const next = makeSummary({ tokenUsage: { input: 48000, cacheCreation: 12500, cacheRead: 8200, output: 16000 } })
      const d = diff(prev, next)

      expect(d).toHaveLength(4)
      for (const change of d) {
        expect(change.path[0]).toBe('tokenUsage')
        expect(change.type).toBe('CHANGE')
      }
      const ratio = patchSize(d) / fullSize(next)
      expect(ratio).toBeLessThan(0.25)
    })
  })

  describe('array mutations (the hard case for diffing)', () => {
    it('subagent status change (nested array element field)', () => {
      const prev = makeSummary()
      const next = makeSummary()
      next.subagents[0].status = 'stopped'
      next.subagents[0].stoppedAt = 1719604000000
      const d = diff(prev, next)

      // microdiff sees path-based changes inside array elements
      expect(d.length).toBeGreaterThanOrEqual(1)
      expect(d.some(c => c.path[0] === 'subagents' && c.path[1] === 0)).toBe(true)
    })

    it('new task added to activeTasks', () => {
      const prev = makeSummary()
      const next = makeSummary()
      next.activeTasks.push({ id: 'task_new', subject: 'New hot task' })
      next.taskCount = 9

      const d = diff(prev, next)
      expect(d.some(c => c.path[0] === 'activeTasks')).toBe(true)
      expect(d.some(c => c.path[0] === 'taskCount')).toBe(true)
    })

    it('task moved from pending to completed', () => {
      const prev = makeSummary()
      const next = makeSummary()
      next.pendingTasks = next.pendingTasks.filter(t => t.id !== 'task_3')
      next.completedTasks.push({ id: 'task_3', subject: 'Deploy to staging' })
      next.pendingTaskCount = 2
      next.completedTaskCount = 4

      const d = diff(prev, next)
      // When arrays are reordered/resized, microdiff emits per-index changes.
      // This is the KNOWN cost: array reshuffles produce O(n) patches.
      // For small arrays (tasks, subagents) this is fine.
      expect(d.length).toBeGreaterThanOrEqual(3)

      const patched = applyPatch(prev as any, d)
      expect(patched.pendingTaskCount).toBe(2)
      expect(patched.completedTaskCount).toBe(4)
    })

    it('connectionIds array replace (socket reconnect)', () => {
      const prev = makeSummary({ connectionIds: ['conn_old'] })
      const next = makeSummary({ connectionIds: ['conn_new'] })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].path).toEqual(['connectionIds', 0])
    })
  })

  describe('field addition and removal', () => {
    it('new optional field appears (e.g. liveStatus set for the first time)', () => {
      const prev = makeSummary()
      const next = makeSummary({ liveStatus: { state: 'done', done: 'Finished the auth work' } })
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].type).toBe('CREATE')
      expect(d[0].path).toEqual(['liveStatus'])
    })

    it('optional field removed (e.g. rateLimit cleared)', () => {
      const prev = makeSummary({ rateLimit: { limited: true, resetAt: 1719604000000 } })
      const next = makeSummary()
      const d = diff(prev, next)

      expect(d).toHaveLength(1)
      expect(d[0].type).toBe('REMOVE')
      expect(d[0].path).toEqual(['rateLimit'])
    })
  })

  describe('no-op (identical state)', () => {
    it('returns empty array for identical objects', () => {
      const prev = makeSummary()
      const next = makeSummary()
      const d = diff(prev, next)

      expect(d).toHaveLength(0)
    })
  })

  describe('patch correctness (round-trip)', () => {
    it('apply patch produces identical object for scalar changes', () => {
      const prev = makeSummary()
      const next = makeSummary({ status: 'idle', lastActivity: 9999999, eventCount: 999, title: 'Changed' })
      const d = diff(prev, next)
      const patched = applyPatch(prev as any, d)

      expect(patched.status).toBe('idle')
      expect(patched.lastActivity).toBe(9999999)
      expect(patched.eventCount).toBe(999)
      expect(patched.title).toBe('Changed')
      // unchanged fields survive
      expect(patched.id).toBe(prev.id)
      expect(patched.project).toBe(prev.project)
    })

    it('apply patch produces identical object for nested changes', () => {
      const prev = makeSummary()
      const next = makeSummary({ tokenUsage: { input: 99999, cacheCreation: 0, cacheRead: 0, output: 50000 } })
      const d = diff(prev, next)
      const patched = applyPatch(prev as any, d)

      expect(patched.tokenUsage).toEqual(next.tokenUsage)
    })
  })

  describe('size economics: when NOT to send a patch', () => {
    it('massive change (many fields) -- patch can exceed full object', () => {
      const prev = makeSummary()
      const next = makeSummary({
        status: 'ended',
        lastActivity: 9999999,
        eventCount: 500,
        title: 'Completely different title',
        summary: 'Completely different summary that is very long and verbose',
        model: 'claude-opus-4-6',
        effortLevel: 'max',
        permissionMode: 'bypassPermissions',
        gitBranch: 'main',
        transport: 'claude-pty',
        activeSubagentCount: 0,
        totalSubagentCount: 10,
        runningBgTaskCount: 0,
        taskCount: 20,
        pendingTaskCount: 0,
        completedTaskCount: 20,
      })
      const d = diff(prev, next)

      // Even with many changes, patch is still likely smaller because unchanged
      // arrays (subagents, tasks with their subjects) aren't included
      const pBytes = patchSize(d)
      const fBytes = fullSize(next)
      // Just log the ratio -- this test documents the crossover point
      console.log(`  many-field change: patch=${pBytes}b, full=${fBytes}b, ratio=${(pBytes / fBytes).toFixed(2)}`)
      // The point: even with ~15 field changes, unchanged nested arrays still
      // save us. But document that the ratio is closer to 1.0.
      expect(d.length).toBeGreaterThan(10)
    })

    it('completely different object (worst case)', () => {
      const prev = makeSummary()
      const next = makeSummary({
        id: 'conv_totally_different',
        project: 'claude://other/different',
        model: 'claude-opus-4-6',
        status: 'ended',
        title: 'Something else entirely',
        summary: 'A very different summary',
        subagents: [{ agentId: 'sa_999', agentType: 'Plan', status: 'running', startedAt: 0, eventCount: 0 }],
        activeTasks: [],
        pendingTasks: [],
        completedTasks: [{ id: 'task_99', subject: 'Everything' }],
        bgTasks: [],
        tokenUsage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
        stats: { totalCostUsd: 99.99, turns: 999 },
      })
      const d = diff(prev, next)

      const pBytes = patchSize(d)
      const fBytes = fullSize(next)
      console.log(`  worst case: patch=${pBytes}b, full=${fBytes}b, ratio=${(pBytes / fBytes).toFixed(2)}`)
      // When nearly everything changed, patch overhead makes it larger.
      // This is where we'd fall back to sending the full object.
    })
  })

  describe('performance', () => {
    it('diffs a realistic summary in < 1ms', () => {
      const prev = makeSummary()
      const next = makeSummary({ status: 'idle', lastActivity: 9999999, eventCount: 200 })

      // warmup
      diff(prev, next)

      const runs = 10000
      const start = performance.now()
      for (let i = 0; i < runs; i++) {
        diff(prev, next)
      }
      const elapsed = performance.now() - start
      const perOp = elapsed / runs

      console.log(`  microdiff: ${perOp.toFixed(4)}ms per diff (${runs} runs)`)
      expect(perOp).toBeLessThan(1)
    })

    it('diffs 50 summaries (fleet broadcast) in < 5ms', () => {
      const summaries = Array.from({ length: 50 }, (_, i) => makeSummary({ id: `conv_${i}`, eventCount: 100 + i }))
      const updated = summaries.map((s, i) => ({ ...s, eventCount: s.eventCount + 1, lastActivity: Date.now() }))

      const start = performance.now()
      for (let i = 0; i < summaries.length; i++) {
        diff(summaries[i], updated[i])
      }
      const elapsed = performance.now() - start

      console.log(`  50-conversation fleet diff: ${elapsed.toFixed(2)}ms`)
      expect(elapsed).toBeLessThan(5)
    })
  })
})

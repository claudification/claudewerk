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
// Load-tolerant perf harness
// ---------------------------------------------------------------------------

/*
 * These perf assertions used to be absolute wall-clock budgets ("50 diffs in
 * < 5ms"). That flakes: on a box running the full suite the measured window is
 * sub-millisecond, so a single scheduler preemption -- worth several ms -- is
 * larger than the whole budget. Observed 0.66ms alone and 7.86ms under load for
 * work that never changed.
 *
 * Two changes make the assertion survive that without going blind:
 *
 *  - MIN-OF-N. Repeat the trial and keep the FASTEST run. A preempted trial is
 *    contaminated with somebody else's CPU time; the fastest is the closest
 *    thing to the true cost we can observe. Averaging would fold the noise in.
 *    Short trials matter here: a 0.5ms window usually fits inside one timeslice,
 *    a 50ms one never does.
 *  - RELATIVE BUDGET. Express the result as a multiple of a reference workload
 *    timed in the same process, in the same trial loop. That cancels the machine
 *    (a slow or busy box slows both) while still failing on a real regression --
 *    a 10x slower microdiff moves the ratio from ~2.4 to ~24.
 */

/** Consumes benchmark results so nothing under measurement can be optimised away. */
let benchSink = 0

/**
 * The reference workload: a pure-JS recursive walk of an object graph. Chosen
 * because it is the same KIND of work microdiff does (property enumeration and
 * traversal over the same fixture), so machine speed and scheduler pressure
 * move it and the diff together.
 */
function walkGraph(node: unknown): number {
  if (node === null || typeof node !== 'object') return 1
  let n = 1
  for (const key in node as Record<string, unknown>) {
    n += walkGraph((node as Record<string, unknown>)[key])
  }
  return n
}

/** Trials per measurement. >= 9 is where the ratio stops moving (measured). */
const PERF_TRIALS = 15

/**
 * Budget as a multiple of the reference workload. Measured ~2.35 on an idle
 * box for both perf cases below; 8 leaves ~3.4x headroom for a hostile machine
 * while still catching anything more than a 3x regression.
 */
const PERF_BUDGET_MULTIPLE = 8

/** Fastest of `trials` runs of `fn`, in ms. */
function bestOfMs(trials: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let t = 0; t < trials; t++) {
    const start = performance.now()
    fn()
    const elapsed = performance.now() - start
    if (elapsed < best) best = elapsed
  }
  return best
}

/** Cost of `work` expressed as a multiple of `reference`, both min-of-N in this process. */
function relativeCost(work: () => void, reference: () => void) {
  // Warm the JIT for both before either is timed, so trial 1 is not the outlier.
  for (let i = 0; i < 3; i++) {
    work()
    reference()
  }
  const workMs = bestOfMs(PERF_TRIALS, work)
  const referenceMs = bestOfMs(PERF_TRIALS, reference)
  return { workMs, referenceMs, ratio: workMs / referenceMs }
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
    it(`diffs a realistic summary within ${PERF_BUDGET_MULTIPLE}x a plain object walk`, () => {
      const prev = makeSummary()
      const next = makeSummary({ status: 'idle', lastActivity: 9999999, eventCount: 200 })

      const runs = 200
      const { workMs, referenceMs, ratio } = relativeCost(
        () => {
          for (let i = 0; i < runs; i++) benchSink += diff(prev, next).length
        },
        () => {
          for (let i = 0; i < runs; i++) benchSink += walkGraph(prev)
        },
      )

      console.log(
        `  microdiff: ${(workMs / runs).toFixed(4)}ms per diff (best of ${PERF_TRIALS} x ${runs} runs), ` +
          `${ratio.toFixed(2)}x the reference walk`,
      )
      expect(benchSink).toBeGreaterThan(0) // the measured work really ran
      expect(referenceMs).toBeGreaterThan(0)
      expect(ratio).toBeLessThan(PERF_BUDGET_MULTIPLE)
    })

    it(`diffs 50 summaries (fleet broadcast) within ${PERF_BUDGET_MULTIPLE}x a plain object walk`, () => {
      const summaries = Array.from({ length: 50 }, (_, i) => makeSummary({ id: `conv_${i}`, eventCount: 100 + i }))
      // Fixed timestamp, not Date.now(): the fixture must not vary between trials.
      const updated = summaries.map(s => ({ ...s, eventCount: s.eventCount + 1, lastActivity: 1719603999999 }))

      const { workMs, referenceMs, ratio } = relativeCost(
        () => {
          for (let i = 0; i < summaries.length; i++) benchSink += diff(summaries[i], updated[i]).length
        },
        () => {
          for (let i = 0; i < summaries.length; i++) benchSink += walkGraph(summaries[i])
        },
      )

      console.log(
        `  50-conversation fleet diff: ${workMs.toFixed(2)}ms vs ${referenceMs.toFixed(2)}ms reference ` +
          `(best of ${PERF_TRIALS}), ${ratio.toFixed(2)}x`,
      )
      expect(benchSink).toBeGreaterThan(0) // the measured work really ran
      expect(referenceMs).toBeGreaterThan(0)
      expect(ratio).toBeLessThan(PERF_BUDGET_MULTIPLE)
    })
  })
})

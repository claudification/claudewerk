import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import type { PersistenceDeps } from './history-persistence'
import {
  consolidateIfDue,
  dumpUserHistory,
  getUserHistory,
  getUserTranscript,
  initHistoryPersistence,
  markDirty,
  recordTurn,
  refreshLiveBlocks,
  resetUserHistory,
  userKey,
} from './history-store'
import { appendTurn, getBlock, ONE_HOUR_MS, toMessages } from './living-history'
import type { ProjectOverviewRow } from './overview'

function row(p: Partial<ProjectOverviewRow> & { project: string }): ProjectOverviewRow {
  return { projectUri: `claude://x/${p.project}`, brief: '', live: 0, working: 0, needsYou: 0, ...p }
}

const stubFold: ChatFn = async req => ({
  content: '- folded memory',
  raw: {},
  model: req.model,
  usage: {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0002,
    costSource: 'openrouter',
  },
})

describe('per-user history store', () => {
  test('getUserHistory is persistent + per-user; anon shares one slot', () => {
    resetUserHistory('alice')
    resetUserHistory(null)
    const a1 = getUserHistory('alice')
    appendTurn(a1, 'user', 'hi', 1)
    expect(getUserHistory('alice').turns).toHaveLength(1) // same instance
    expect(getUserHistory('bob').turns).toHaveLength(0) // different user
    expect(userKey(null)).toBe(userKey('')) // anon sentinel
    expect(userKey('alice')).toBe('alice')
  })

  test('resetUserHistory drops the slot', () => {
    const h = getUserHistory('carol')
    appendTurn(h, 'user', 'x', 1)
    resetUserHistory('carol')
    expect(getUserHistory('carol').turns).toHaveLength(0)
  })
})

describe('refreshLiveBlocks', () => {
  test('builds fleet + briefs + notes blocks and REWRITES in place', () => {
    resetUserHistory('u')
    const h = getUserHistory('u')
    const rows = [
      row({ project: 'arr', live: 0, brief: 'movie release tracker' }),
      row({ project: 'remote-claude', live: 2, working: 1, needsYou: 1, idleMin: 3, brief: 'the broker' }),
    ]
    refreshLiveBlocks(h, { rows, durableNotes: 'prefers Sonnet', now: 100 })
    expect(getBlock(h, 'fleet')?.content).toContain('remote-claude: 2 live, 1 working, 1 needs-you, idle 3m')
    expect(getBlock(h, 'fleet')?.content).toContain('arr: idle (in memory)')
    expect(getBlock(h, 'briefs')?.content).toContain('## arr')
    expect(getBlock(h, 'notes')?.content).toBe('prefers Sonnet')

    // second refresh REWRITES (no accumulation) -- still one fleet block.
    refreshLiveBlocks(h, { rows: [row({ project: 'arr', live: 5 })], durableNotes: '', now: 200 })
    expect(getBlock(h, 'fleet')?.content).toBe('- arr: 5 live')
    expect(getBlock(h, 'notes')).toBeUndefined() // empty notes -> block dropped
  })

  test('brief budget drops overflow with a progressive tail', () => {
    resetUserHistory('u2')
    const h = getUserHistory('u2')
    const rows = [
      row({ project: 'p1', live: 1, brief: 'x'.repeat(200) }),
      row({ project: 'p2', live: 1, brief: 'y'.repeat(200) }),
    ]
    refreshLiveBlocks(h, { rows, durableNotes: '', now: 1, briefBudgetChars: 230 })
    const briefs = getBlock(h, 'briefs')?.content ?? ''
    expect(briefs).toContain('## p1')
    expect(briefs).toContain('+1 more in memory')
  })
})

describe('consolidateIfDue', () => {
  test('not due (tiny history) -> null, no fold', async () => {
    resetUserHistory('q')
    const h = getUserHistory('q')
    appendTurn(h, 'user', 'small old', 0) // aged but under the size floor
    const res = await consolidateIfDue(h, 'q', 2 * ONE_HOUR_MS, stubFold)
    expect(res).toBeNull()
    expect(h.turns).toHaveLength(1)
  })

  test('due (size valve) -> folds + tracks the per-user clock (debounce)', async () => {
    resetUserHistory('r')
    const h = getUserHistory('r')
    const now = 2 * ONE_HOUR_MS
    // a big aged turn trips the size valve regardless of interval
    appendTurn(h, 'user', 'x'.repeat(30_000), 0)
    const res = await consolidateIfDue(h, 'r', now, stubFold)
    expect(res?.ran).toBe(true)
    expect(h.turns).toHaveLength(0) // aged turn folded away
    expect(getBlock(h, 'memory')?.content).toBe('- folded memory')

    // immediately after, a fresh small aged turn must NOT re-fold (debounce held)
    appendTurn(h, 'user', 'tiny', now - ONE_HOUR_MS - 1)
    const res2 = await consolidateIfDue(h, 'r', now + 1000, stubFold)
    expect(res2).toBeNull()
  })
})

describe('viewable transcript ring (A0)', () => {
  test('FIFO cap holds the LAST 100 turns; consolidating the LLM window never shrinks it', async () => {
    resetUserHistory('ring')
    for (let i = 1; i <= 130; i++) recordTurn('ring', i % 2 ? 'user' : 'assistant', `turn ${i}`, i)
    const ring = getUserTranscript('ring')
    expect(ring).toHaveLength(100) // 130 appended, capped to the last 100
    expect(ring[0].content).toBe('turn 31') // 1..30 evicted
    expect(ring[99].content).toBe('turn 130')

    // Folding the SEPARATE LLM-window history must not touch the transcript ring.
    const h = getUserHistory('ring')
    appendTurn(h, 'user', 'x'.repeat(30_000), 0) // big + aged -> size valve fires
    const res = await consolidateIfDue(h, 'ring', 2 * ONE_HOUR_MS, stubFold)
    expect(res?.ran).toBe(true)
    expect(h.turns).toHaveLength(0) // LLM window pruned
    expect(getUserTranscript('ring')).toHaveLength(100) // viewable transcript intact
  })

  test('dumpUserHistory carries the transcript even when the LLM window is absent', () => {
    resetUserHistory('donly')
    recordTurn('donly', 'user', 'hello', 1)
    recordTurn('donly', 'assistant', 'hi there', 2)
    const dump = dumpUserHistory('donly')
    expect(dump.exists).toBe(false) // no LivingHistory created
    expect(dump.transcript.map(t => t.content)).toEqual(['hello', 'hi there'])
    expect(dump.turns).toHaveLength(0)
  })

  test('resetUserHistory clears the transcript ring too', () => {
    recordTurn('wipe', 'user', 'x', 1)
    resetUserHistory('wipe')
    expect(getUserTranscript('wipe')).toHaveLength(0)
  })
})

describe('persistence wiring (Slice A)', () => {
  /** A synchronous in-memory fs (schedule fires immediately) for the round-trip. */
  function syncFs() {
    const files = new Map<string, string>()
    const deps: PersistenceDeps = {
      readdir: dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
      readFile: path =>
        files.get(path) ??
        (() => {
          throw new Error('ENOENT')
        })(),
      writeFile: (path, data) => files.set(path, data),
      rename: (from, to) => {
        files.set(to, files.get(from) as string)
        files.delete(from)
      },
      remove: path => files.delete(path),
      ensureDir: () => {},
      now: () => 1,
      schedule: fn => {
        fn()
        return 0
      }, // fire immediately
      cancel: () => {},
    }
    return { files, deps }
  }

  test('markDirty persists, and a fresh init reloads history + transcript (survives restart)', () => {
    const { files, deps } = syncFs()
    resetUserHistory('persist-u')
    initHistoryPersistence('/cache', deps) // arm the saver against the fake fs

    const h = getUserHistory('persist-u')
    appendTurn(h, 'user', 'durable turn', 5)
    recordTurn('persist-u', 'user', 'viewable turn', 5)
    markDirty('persist-u') // schedule -> fires immediately in syncFs

    expect([...files.keys()].some(k => k.includes('/dispatcher/'))).toBe(true)

    // Simulate a restart: a fresh process has the file on disk but empty memory.
    // Snapshot the file, wipe state (this also deletes the file), restore it, re-init.
    const snapshot = new Map(files)
    resetUserHistory('persist-u')
    expect(getUserHistory('persist-u').turns).toHaveLength(0)
    for (const [k, v] of snapshot) files.set(k, v)
    initHistoryPersistence('/cache', deps)

    expect(getUserHistory('persist-u').turns.map(t => t.content)).toEqual(['durable turn'])
    expect(getUserTranscript('persist-u').map(t => t.content)).toEqual(['viewable turn'])
  })

  test('resetUserHistory deletes the persisted file', () => {
    const { files, deps } = syncFs()
    initHistoryPersistence('/cache', deps)
    const h = getUserHistory('wipe-p')
    appendTurn(h, 'user', 'x', 1)
    markDirty('wipe-p')
    expect(files.size).toBe(1)
    resetUserHistory('wipe-p')
    expect(files.size).toBe(0) // persisted file deleted
  })
})

describe('toMessages over a refreshed history', () => {
  test('state blocks lead, the user turn follows', () => {
    resetUserHistory('z')
    const h = getUserHistory('z')
    refreshLiveBlocks(h, { rows: [row({ project: 'arr', live: 1 })], durableNotes: '', now: 1 })
    appendTurn(h, 'user', 'check arr', 2)
    const msgs = toMessages(h)
    expect(msgs[0].content).toContain('<fleet id="fleet">')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'check arr' })
  })
})

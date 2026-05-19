/**
 * Tier 1 unit tests for `session-observer` -- the no-hook ccSessionId
 * derivation. Drives the observer against an injected fake `list` (the
 * `listFn` seam) and a fake project-dir scan (the `scanProjectDirFn` seam),
 * so no socket, no `claude` install and no real filesystem are needed.
 *
 * Spike finding 2 (plan-daemon-launch-ux.md section 8): a daemon job's
 * `JobRecord.sessionId` is fixed at dispatch and NEVER rotates on `/clear`.
 * Rotation is therefore detected from the project transcript dir, not from
 * `list` -- these tests pin both halves of that design.
 */
import { describe, expect, test } from 'bun:test'
import type { JobRecord, ListResponse } from '../shared/cc-daemon/types'
import type { DaemonMode } from './cli-args'
import { type DaemonSessionObserver, type JsonlEntry, observeDaemonSession } from './session-observer'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Build a `list` response from partial job records. */
function listOf(...jobs: Partial<JobRecord>[]): ListResponse {
  return {
    ok: true,
    op: 'list',
    jobs: jobs.map(j => ({ short: '', sessionId: '', cwd: '', state: 'working', ...j })),
  }
}

/** Options for the `observe` helper -- only the seams a test cares about. */
interface ObserveArgs {
  mode?: DaemonMode
  onSessionId: (id: string) => void
  onGone?: () => void
  onError?: (err: Error) => void
  listFn: (sock: string) => Promise<ListResponse>
  scanProjectDirFn?: (dir: string) => Promise<JsonlEntry[]>
}

/** Start an observer with test defaults (10ms poll, empty dir scan). */
function observe(args: ObserveArgs): DaemonSessionObserver {
  return observeDaemonSession({
    controlSock: '/fake.sock',
    daemonShort: 'aaaa1111',
    mode: args.mode ?? 'new',
    cwd: '/fake/worker/cwd',
    pollIntervalMs: 10,
    onSessionId: args.onSessionId,
    onGone: args.onGone,
    onError: args.onError,
    listFn: args.listFn,
    scanProjectDirFn: args.scanProjectDirFn ?? (async () => []),
  })
}

describe('observeDaemonSession -- initial ccSessionId', () => {
  test('new mode: derives the initial id from JobRecord.sessionId', async () => {
    const seen: string[] = []
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-1' }),
    })
    await sleep(40)
    obs.stop()
    expect(seen).toEqual(['sess-1'])
  })

  test('new mode: skips an empty sessionId until the worker has booted', async () => {
    const seen: string[] = []
    let sessionId = ''
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId }),
    })
    await sleep(30)
    sessionId = 'sess-late'
    await sleep(40)
    obs.stop()
    expect(seen).toEqual(['sess-late'])
  })

  test('attach mode: derives the initial id from the newest-mtime JSONL, not the stale list id', async () => {
    const seen: string[] = []
    const obs = observe({
      mode: 'attach',
      onSessionId: id => seen.push(id),
      // The daemon still reports the dispatch-time id -- stale after a /clear.
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'stale-dispatch-id' }),
      scanProjectDirFn: async () => [
        { id: 'current-after-clear', mtimeMs: 200 },
        { id: 'pre-clear', mtimeMs: 100 },
      ],
    })
    await sleep(40)
    obs.stop()
    expect(seen).toEqual(['current-after-clear'])
  })

  test('attach mode: falls back to the list id while the project dir is empty', async () => {
    const seen: string[] = []
    const obs = observe({
      mode: 'attach',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-fallback' }),
      scanProjectDirFn: async () => [],
    })
    await sleep(40)
    obs.stop()
    expect(seen).toEqual(['sess-fallback'])
  })

  test('ignores jobs that are not our worker short', async () => {
    const seen: string[] = []
    const obs = observe({
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'bbbb2222', sessionId: 'other' }),
    })
    await sleep(40)
    obs.stop()
    expect(seen).toEqual([])
  })
})

describe('observeDaemonSession -- /clear rotation via the project dir', () => {
  test('reports a new ccSessionId when a strictly-newer JSONL appears', async () => {
    const seen: string[] = []
    let scan: JsonlEntry[] = [{ id: 'sess-1', mtimeMs: 100 }]
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      // The daemon's JobRecord.sessionId stays pinned to sess-1 forever.
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-1' }),
      scanProjectDirFn: async () => scan,
    })
    await sleep(40)
    // /clear: a fresh transcript JSONL is created, newer than sess-1's.
    scan = [
      { id: 'sess-2', mtimeMs: 200 },
      { id: 'sess-1', mtimeMs: 100 },
    ]
    await sleep(40)
    obs.stop()
    expect(seen).toEqual(['sess-1', 'sess-2'])
  })

  test('does NOT rotate when the worker just writes its current JSONL', async () => {
    const seen: string[] = []
    let mtime = 100
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-1' }),
      // Same id, mtime climbs as the worker appends turns -- not a rotation.
      scanProjectDirFn: async () => {
        mtime += 50
        return [{ id: 'sess-1', mtimeMs: mtime }]
      },
    })
    await sleep(60)
    obs.stop()
    expect(seen).toEqual(['sess-1'])
  })

  test('does NOT rotate before the current JSONL is visible in the dir', async () => {
    const seen: string[] = []
    // The worker's own sess-1.jsonl has not appeared; only a stale unrelated
    // JSONL is in the dir. The rotation guard requires the current session's
    // JSONL to be present, so this must not be mistaken for a /clear.
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-1' }),
      scanProjectDirFn: async () => [{ id: 'old-unrelated', mtimeMs: 50 }],
    })
    await sleep(50)
    obs.stop()
    expect(seen).toEqual(['sess-1'])
  })

  test('does NOT rotate to a JSONL that merely ties the current mtime', async () => {
    const seen: string[] = []
    const obs = observe({
      mode: 'new',
      onSessionId: id => seen.push(id),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 'sess-1' }),
      scanProjectDirFn: async () => [
        { id: 'sibling', mtimeMs: 100 },
        { id: 'sess-1', mtimeMs: 100 },
      ],
    })
    await sleep(50)
    obs.stop()
    expect(seen).toEqual(['sess-1'])
  })
})

describe('observeDaemonSession -- worker lifecycle', () => {
  test('fires onGone once the worker leaves the roster', async () => {
    let present = true
    let gone = 0
    const obs = observe({
      onSessionId: () => {},
      onGone: () => gone++,
      listFn: async () => (present ? listOf({ short: 'aaaa1111', sessionId: 's' }) : listOf()),
    })
    await sleep(30)
    present = false
    await sleep(40)
    obs.stop()
    expect(gone).toBe(1)
  })

  test('does NOT fire onGone before the worker is ever seen (startup race)', async () => {
    let gone = 0
    const obs = observe({
      onSessionId: () => {},
      onGone: () => gone++,
      listFn: async () => listOf(), // worker not registered yet
    })
    await sleep(50)
    obs.stop()
    expect(gone).toBe(0)
  })

  test('reports list failures via onError and keeps polling', async () => {
    const errors: string[] = []
    let fail = true
    const obs = observe({
      onSessionId: () => {},
      onError: e => errors.push(e.message),
      listFn: async () => {
        if (fail) throw new Error('socket gone')
        return listOf({ short: 'aaaa1111', sessionId: 's' })
      },
    })
    await sleep(30)
    fail = false
    await sleep(40)
    obs.stop()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toBe('socket gone')
  })

  test('reports project-dir scan failures via onError', async () => {
    const errors: string[] = []
    const obs = observe({
      mode: 'new',
      onSessionId: () => {},
      onError: e => errors.push(e.message),
      listFn: async () => listOf({ short: 'aaaa1111', sessionId: 's' }),
      scanProjectDirFn: async () => {
        throw new Error('readdir blew up')
      },
    })
    await sleep(40)
    obs.stop()
    expect(errors).toContain('readdir blew up')
  })

  test('stop() halts polling', async () => {
    let calls = 0
    const obs = observe({
      onSessionId: () => {},
      listFn: async () => {
        calls++
        return listOf()
      },
    })
    await sleep(30)
    obs.stop()
    const after = calls
    await sleep(40)
    expect(calls).toBe(after)
  })
})

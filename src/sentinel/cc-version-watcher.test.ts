/**
 * Tier-1 unit tests for the CC daemon version watcher.
 *
 * The watcher is a pure factory: `ping` / `loadLastSeen` / `persistLastSeen` /
 * `emit` are injected, so the diff logic + persistence + emission can be
 * exercised without a real socket or filesystem.
 */
import { describe, expect, it } from 'bun:test'
import type { CcMinVersionUnmet, CcVersionChanged } from '../shared/protocol'
import {
  CC_MIN_VERSION_FOR_DAEMON,
  ccVersionBelow,
  createCcVersionWatcher,
  diffCcVersion,
  type LastSeenCcVersion,
  type PingResult,
  parseCcVersion,
} from './cc-version-watcher'

describe('diffCcVersion', () => {
  it('returns null when both axes match', () => {
    const diff = diffCcVersion({ version: '2.1.144', proto: 1 }, { version: '2.1.144', proto: 1 })
    expect(diff).toBeNull()
  })

  it('flags a version bump with prev/next pair', () => {
    const diff = diffCcVersion({ version: '2.1.144', proto: 1 }, { version: '2.1.145', proto: 1 })
    expect(diff).toEqual({ fromVersion: '2.1.144', toVersion: '2.1.145', fromProto: 1, toProto: 1 })
  })

  it('flags a proto bump alone', () => {
    const diff = diffCcVersion({ version: '2.1.144', proto: 1 }, { version: '2.1.144', proto: 2 })
    expect(diff).toEqual({ fromVersion: '2.1.144', toVersion: '2.1.144', fromProto: 1, toProto: 2 })
  })

  it('first-observation: both prev fields null, returns null prev in the diff', () => {
    const diff = diffCcVersion({ version: null, proto: null }, { version: '2.1.144', proto: 1 })
    expect(diff).toEqual({ fromVersion: null, toVersion: '2.1.144', fromProto: null, toProto: 1 })
  })
})

interface Harness {
  pingResults: Array<PingResult | null | Error>
  stored: LastSeenCcVersion
  emitted: CcVersionChanged[]
  errors: Error[]
}

function makeHarness(initial: LastSeenCcVersion, pingResults: Array<PingResult | null | Error>): Harness {
  return { pingResults, stored: { ...initial }, emitted: [], errors: [] }
}

function makeWatcher(h: Harness, sentinelId = 'snt_test', nowValue = 1_700_000_000_000) {
  return createCcVersionWatcher({
    sentinelId,
    intervalMs: 60_000,
    now: () => nowValue,
    ping: async () => {
      const r = h.pingResults.shift()
      if (r instanceof Error) throw r
      return r ?? null
    },
    loadLastSeen: () => h.stored,
    persistLastSeen: next => {
      h.stored = next
    },
    emit: ev => h.emitted.push(ev),
    onError: err => h.errors.push(err),
  })
}

describe('createCcVersionWatcher', () => {
  it('no diff -> no emit, no persist', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [{ version: '2.1.144', proto: 1 }])
    const w = makeWatcher(h)
    await w.runOnce()
    expect(h.emitted).toEqual([])
    expect(h.stored).toEqual({ version: '2.1.144', proto: 1 })
  })

  it('version bump -> single emit with prev/next + persist', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [{ version: '2.1.145', proto: 1 }])
    const w = makeWatcher(h, 'snt_x', 1_700_000_000_999)
    await w.runOnce()
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]).toEqual({
      type: 'cc_version_changed',
      sentinelId: 'snt_x',
      fromVersion: '2.1.144',
      toVersion: '2.1.145',
      fromProto: 1,
      toProto: 1,
      observedAt: 1_700_000_000_999,
    })
    expect(h.stored).toEqual({ version: '2.1.145', proto: 1 })
  })

  it('proto bump alone -> emits with the bumped proto', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [{ version: '2.1.144', proto: 2 }])
    const w = makeWatcher(h)
    await w.runOnce()
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]?.fromProto).toBe(1)
    expect(h.emitted[0]?.toProto).toBe(2)
    expect(h.stored).toEqual({ version: '2.1.144', proto: 2 })
  })

  it('first observation after install -> emit with fromVersion / fromProto null', async () => {
    const h = makeHarness({ version: null, proto: null }, [{ version: '2.1.144', proto: 1 }])
    const w = makeWatcher(h)
    await w.runOnce()
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]?.fromVersion).toBeNull()
    expect(h.emitted[0]?.fromProto).toBeNull()
    expect(h.emitted[0]?.toVersion).toBe('2.1.144')
  })

  it('ping returns null (daemon unreachable) -> silent skip, no persist', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [null])
    const w = makeWatcher(h)
    await w.runOnce()
    expect(h.emitted).toEqual([])
    expect(h.errors).toEqual([])
    expect(h.stored).toEqual({ version: '2.1.144', proto: 1 })
  })

  it('ping throws -> onError fired, no emit', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [new Error('boom')])
    const w = makeWatcher(h)
    await w.runOnce()
    expect(h.emitted).toEqual([])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toBe('boom')
  })

  it('runOnce is reentrant-safe (concurrent calls coalesce)', async () => {
    const h = makeHarness({ version: '2.1.144', proto: 1 }, [{ version: '2.1.145', proto: 1 }])
    const w = makeWatcher(h)
    await Promise.all([w.runOnce(), w.runOnce()])
    expect(h.emitted).toHaveLength(1)
  })
})

describe('parseCcVersion', () => {
  it('parses 2.1.150 -> [2,1,150]', () => {
    expect(parseCcVersion('2.1.150')).toEqual([2, 1, 150])
  })
  it('rejects garbage', () => {
    expect(parseCcVersion('not.a.version')).toBeNull()
    expect(parseCcVersion('2.1')).toBeNull()
  })
})

describe('ccVersionBelow', () => {
  it('returns true when installed is strictly below required', () => {
    expect(ccVersionBelow('2.1.141', '2.1.142')).toBe(true)
    expect(ccVersionBelow('2.0.999', '2.1.142')).toBe(true)
  })
  it('returns false when installed equals or exceeds required', () => {
    expect(ccVersionBelow('2.1.142', '2.1.142')).toBe(false)
    expect(ccVersionBelow('2.1.143', '2.1.142')).toBe(false)
    expect(ccVersionBelow('2.2.0', '2.1.142')).toBe(false)
  })
  it('returns false for unparseable input (defensive: no false-positive banner)', () => {
    expect(ccVersionBelow('garbage', '2.1.142')).toBe(false)
  })
})

describe('createCcVersionWatcher -- min-version safety net (sweep C4)', () => {
  function makeMinHarness(versionToPing: string) {
    const emittedMin: CcMinVersionUnmet[] = []
    const watcher = createCcVersionWatcher({
      sentinelId: 'snt_min',
      now: () => 1_700_000_000_000,
      ping: async () => ({ version: versionToPing, proto: 1 }),
      loadLastSeen: () => ({ version: versionToPing, proto: 1 }), // no diff -- isolate the min path
      persistLastSeen: () => {},
      emit: () => {},
      isDaemonDefault: () => true,
      emitMinUnmet: ev => emittedMin.push(ev),
    })
    return { emittedMin, watcher }
  }

  it('fires once when installed CC is below the floor and daemon is the default', async () => {
    const { emittedMin, watcher } = makeMinHarness('2.1.141')
    await watcher.runOnce()
    expect(emittedMin).toHaveLength(1)
    expect(emittedMin[0]).toMatchObject({
      type: 'cc_min_version_unmet',
      sentinelId: 'snt_min',
      installedVersion: '2.1.141',
      requiredVersion: CC_MIN_VERSION_FOR_DAEMON,
      requiredFor: 'daemon-backend',
    })
  })

  it('is idempotent across polls for the same (installed, required) gap', async () => {
    const { emittedMin, watcher } = makeMinHarness('2.1.141')
    await watcher.runOnce()
    await watcher.runOnce()
    await watcher.runOnce()
    expect(emittedMin).toHaveLength(1)
  })

  it('does NOT fire when the installed version meets the floor', async () => {
    const { emittedMin, watcher } = makeMinHarness('2.1.142')
    await watcher.runOnce()
    expect(emittedMin).toEqual([])
  })

  it('does NOT fire when daemon is opted out (isDaemonDefault returns false)', async () => {
    const emittedMin: CcMinVersionUnmet[] = []
    const watcher = createCcVersionWatcher({
      sentinelId: 'snt_min',
      ping: async () => ({ version: '2.1.140', proto: 1 }),
      loadLastSeen: () => ({ version: '2.1.140', proto: 1 }),
      persistLastSeen: () => {},
      emit: () => {},
      isDaemonDefault: () => false,
      emitMinUnmet: ev => emittedMin.push(ev),
    })
    await watcher.runOnce()
    expect(emittedMin).toEqual([])
  })

  it('re-fires after the gap closes and re-opens (suppressor reset)', async () => {
    const emittedMin: CcMinVersionUnmet[] = []
    const versions: string[] = ['2.1.141', '2.1.142', '2.1.140']
    const watcher = createCcVersionWatcher({
      sentinelId: 'snt_min',
      ping: async () => ({ version: versions.shift() ?? '2.1.142', proto: 1 }),
      loadLastSeen: () => ({ version: '2.1.142', proto: 1 }), // never diffs
      persistLastSeen: () => {},
      emit: () => {},
      isDaemonDefault: () => true,
      emitMinUnmet: ev => emittedMin.push(ev),
    })
    await watcher.runOnce() // 2.1.141 -- fire
    await watcher.runOnce() // 2.1.142 -- gap closes, suppressor resets
    await watcher.runOnce() // 2.1.140 -- gap reopens, fire again
    expect(emittedMin).toHaveLength(2)
    expect(emittedMin[0]?.installedVersion).toBe('2.1.141')
    expect(emittedMin[1]?.installedVersion).toBe('2.1.140')
  })
})

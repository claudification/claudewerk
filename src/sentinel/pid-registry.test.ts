import { describe, expect, test } from 'bun:test'
import { AdoptedChildren, mergeRegistryEntries, type PidRegistryEntry, reconcileRegistry } from './pid-registry'

const entry = (conversationId: string, pid: number): PidRegistryEntry => ({
  conversationId,
  pid,
  cwd: `/projects/${conversationId}`,
  startedAt: '2026-08-01T00:00:00.000Z',
})

/** Probe stub: only the listed PIDs are alive. */
const aliveOnly =
  (...pids: number[]) =>
  (pid: number) =>
    pids.includes(pid)

describe('reconcileRegistry', () => {
  test('splits survivors from dead PIDs', () => {
    const entries = [entry('a', 100), entry('b', 200), entry('c', 300)]
    const { alive, dead } = reconcileRegistry(entries, aliveOnly(100, 300))
    expect(alive.map(e => e.conversationId)).toEqual(['a', 'c'])
    expect(dead.map(e => e.conversationId)).toEqual(['b'])
  })

  test('empty registry yields empty result', () => {
    expect(reconcileRegistry([], aliveOnly())).toEqual({ alive: [], dead: [] })
  })
})

describe('AdoptedChildren', () => {
  test('REGRESSION: a surviving child stays tracked instead of being forgotten', () => {
    // The bug: loadAndCheckPidRegistry() found live survivors, logged them, and
    // dropped them on the floor -- so the next writePidRegistry() (which
    // serialised only trackedChildren) erased them permanently. Every sentinel
    // restart abandoned a whole generation of agent hosts.
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('survivor', 100)])

    expect(adopted.size).toBe(1)
    expect(adopted.values().map(e => e.pid)).toEqual([100])
  })

  test('REGRESSION: survivors round-trip through the persisted registry', () => {
    // Restart #1: one live child is written out, then re-adopted on boot.
    const adopted = new AdoptedChildren()
    const { alive } = reconcileRegistry([entry('survivor', 100)], aliveOnly(100))
    adopted.adopt(alive)

    // Restart #2 must still see it. Before the fix this serialised to [].
    const persisted = mergeRegistryEntries([], adopted.values())
    expect(persisted.map(e => e.conversationId)).toEqual(['survivor'])

    const second = new AdoptedChildren()
    second.adopt(reconcileRegistry(persisted, aliveOnly(100)).alive)
    expect(second.size).toBe(1)
  })

  test('generations accumulate rather than replacing each other', () => {
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('gen1', 100)])
    adopted.adopt([entry('gen2', 200)])
    expect(
      adopted
        .values()
        .map(e => e.pid)
        .sort(),
    ).toEqual([100, 200])
  })

  test('re-adopting the same conversation does not duplicate it', () => {
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('a', 100)])
    adopted.adopt([entry('a', 100)])
    expect(adopted.size).toBe(1)
  })

  test('release() drops a conversation the sentinel has re-spawned itself', () => {
    // Once this sentinel owns a real Subprocess for the conversation, the
    // PID-only adopted record is stale and must not shadow it.
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('a', 100)])
    adopted.release('a')
    expect(adopted.size).toBe(0)
  })

  test('prune() removes dead survivors and returns them for reporting', () => {
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('a', 100), entry('b', 200)])

    const reaped = adopted.prune(aliveOnly(100))

    expect(reaped.map(e => e.conversationId)).toEqual(['b'])
    expect(adopted.values().map(e => e.pid)).toEqual([100])
  })

  test('prune() reports each dead survivor exactly once', () => {
    const adopted = new AdoptedChildren()
    adopted.adopt([entry('a', 100)])

    expect(adopted.prune(aliveOnly()).length).toBe(1)
    expect(adopted.prune(aliveOnly()).length).toBe(0)
  })
})

describe('mergeRegistryEntries', () => {
  test('persists both this generation and adopted survivors', () => {
    const merged = mergeRegistryEntries([entry('new', 300)], [entry('old', 100)])
    expect(merged.map(e => e.conversationId).sort()).toEqual(['new', 'old'])
  })

  test('a live tracked child wins over a stale adopted record', () => {
    // Same conversation re-spawned under a new PID: only the new PID may persist,
    // otherwise a later reap would report the wrong process as dead.
    const merged = mergeRegistryEntries([entry('a', 999)], [entry('a', 100)])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.pid).toBe(999)
  })
})

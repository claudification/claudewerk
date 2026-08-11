/**
 * Who a schedule runs AS.
 *
 * The engine re-checks the owner's grants at every fire, so an owner that does
 * not resolve is not a small error -- it is a schedule that looks armed in the
 * panel and then disarms itself after five silent failures, at 03:00, weeks
 * later. These tests pin that the same predicate is applied UP FRONT.
 *
 * The directory is injected rather than `mock.module`d: that mock is
 * process-global and would break every sibling suite that imports the real
 * auth module in the same run.
 */

import { describe, expect, test } from 'bun:test'
import type { OwnerDirectory } from './owner'
import { resolveScheduleOwner } from './owner'

interface FakeUser {
  name: string
  revoked?: boolean
  canSpawn?: boolean
}

function directory(users: FakeUser[]): OwnerDirectory {
  const may = (name: string) => {
    const u = users.find(x => x.name === name)
    return Boolean(u && !u.revoked && u.canSpawn)
  }
  return {
    exists: name => users.some(u => u.name === name),
    maySpawn: may,
    spawnCapable: () => users.map(u => u.name).filter(may),
  }
}

const SPAWNER = { name: 'jonas', canSpawn: true }

describe('resolveScheduleOwner', () => {
  test('a single spawn-capable user is unambiguous and needs no argument', () => {
    expect(resolveScheduleOwner(undefined, directory([SPAWNER]))).toEqual({ ok: true, userName: 'jonas' })
  })

  test('several candidates refuse to guess, and say who they are', () => {
    const res = resolveScheduleOwner(undefined, directory([SPAWNER, { name: 'ada', canSpawn: true }]))
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('jonas')
    expect(res.ok === false && res.error).toContain('ada')
  })

  test('a named owner is VERIFIED, not taken on trust', () => {
    expect(resolveScheduleOwner('mallory', directory([SPAWNER])).ok).toBe(false)
  })

  test('a real user WITHOUT spawn permission is refused -- it could never fire', () => {
    const res = resolveScheduleOwner('reader', directory([{ name: 'reader', canSpawn: false }]))
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('spawn permission')
  })

  test('a revoked user is not a candidate, even holding the grant', () => {
    const dir = directory([{ name: 'gone', revoked: true, canSpawn: true }])
    expect(resolveScheduleOwner(undefined, dir).ok).toBe(false)
    expect(resolveScheduleOwner('gone', dir).ok).toBe(false)
  })

  test('nobody at all is an error, not a schedule that silently never runs', () => {
    const res = resolveScheduleOwner(undefined, directory([]))
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('could never fire')
  })

  test('the sole candidate is picked even when other users exist without spawn', () => {
    const dir = directory([SPAWNER, { name: 'reader', canSpawn: false }])
    expect(resolveScheduleOwner(undefined, dir)).toEqual({ ok: true, userName: 'jonas' })
  })
})

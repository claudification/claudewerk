/**
 * What a parked surface is allowed to claim about itself.
 *
 * The property worth pinning: UNREAD means "it finished while nobody was
 * looking". A run that ends in front of you is not news, and marking it unread
 * would train the badge to be ignored -- which is the only way this feature can
 * actually fail.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SurfaceActivity } from './modal-manager-types'
import { nextActivity, sameActivity } from './surface-activity'
import { useModalManagerStore } from './use-modal-manager'

const OPTS = { id: 'vacuum', kind: 'vacuum', title: 'Vacuum' }
const store = () => useModalManagerStore.getState()
const activity = () => store().records.vacuum?.activity

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
})

describe('the activity reducer', () => {
  const running: SurfaceActivity = { status: 'running', tick: 3, pulseAt: 100, unseen: false }

  it('stamps a fresh pulse only when the tick advances', () => {
    expect(nextActivity(running, { status: 'running', tick: 3 }, 'inline', 900).pulseAt).toBe(100)
    expect(nextActivity(running, { status: 'running', tick: 4 }, 'inline', 900).pulseAt).toBe(900)
  })

  it('marks a finish UNREAD when it happens off-screen', () => {
    expect(nextActivity(running, { status: 'done' }, 'docked', 900).unseen).toBe(true)
    expect(nextActivity(running, { status: 'error' }, 'detached', 900).unseen).toBe(true)
  })

  it('does NOT mark a finish you watched happen', () => {
    expect(nextActivity(running, { status: 'done' }, 'inline', 900).unseen).toBe(false)
  })

  it('clears unread when a new run starts', () => {
    const done: SurfaceActivity = { status: 'done', finishedAt: 500, unseen: true }
    expect(nextActivity(done, { status: 'running', tick: 1 }, 'docked', 900).unseen).toBe(false)
    expect(nextActivity(done, { status: 'running', tick: 1 }, 'docked', 900).finishedAt).toBeUndefined()
  })

  it('holds the finish clock across repeats, so the tile does not re-announce', () => {
    const done = nextActivity(running, { status: 'done' }, 'docked', 900)
    expect(nextActivity(done, { status: 'done' }, 'docked', 1500).finishedAt).toBe(900)
  })

  it('treats a report with nothing new as nothing new', () => {
    expect(sameActivity(running, { status: 'running', tick: 3 })).toBe(true)
    expect(sameActivity(running, { status: 'running', tick: 4 })).toBe(false)
    expect(sameActivity(undefined, { status: 'running' })).toBe(false)
  })
})

describe('the manager', () => {
  it('leaves a surface that never reports completely unmarked', () => {
    store().open(OPTS, { type: 'global' })
    expect(activity()).toBeUndefined()
  })

  it('ignores a report for a closed surface', () => {
    store().reportActivity('vacuum', { status: 'running' })
    expect(store().records.vacuum).toBeUndefined()
  })

  it('clears the unread mark when the surface is restored', () => {
    store().open(OPTS, { type: 'global' })
    store().minimize('vacuum')
    store().reportActivity('vacuum', { status: 'running', tick: 1 })
    store().reportActivity('vacuum', { status: 'done', label: '2 months archived' })
    expect(activity()?.unseen).toBe(true)

    store().restore('vacuum')
    expect(activity()?.unseen).toBe(false)
    // The result itself stays -- restoring reads the news, it does not delete it.
    expect(activity()?.label).toBe('2 months archived')
  })

  it('keeps reported work across a re-open of the same surface', () => {
    store().open(OPTS, { type: 'global' })
    store().reportActivity('vacuum', { status: 'running', label: 'measuring' })
    store().open(OPTS, { type: 'global' })
    expect(activity()?.label).toBe('measuring')
  })

  it('drops it on close -- a re-opened surface starts silent', () => {
    store().open(OPTS, { type: 'global' })
    store().reportActivity('vacuum', { status: 'running' })
    store().close('vacuum')
    store().open(OPTS, { type: 'global' })
    expect(activity()).toBeUndefined()
  })
})

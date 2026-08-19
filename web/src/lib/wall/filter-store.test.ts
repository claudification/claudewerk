import { beforeEach, describe, expect, it } from 'vitest'
import { projectToken, selectWallProject, useWallFilterStore, type WallFilterState } from './filter'
import { stripProjectTokens, toggledProject, withProject } from './project-token'

const store = (): WallFilterState => useWallFilterStore.getState()

beforeEach(() => {
  store().clear()
})

describe('projectToken', () => {
  it('lowercases and takes the first whitespace-free word', () => {
    expect(projectToken('Remote-Claude')).toBe('remote-claude')
    expect(projectToken('  anvil md  ')).toBe('anvil')
    expect(projectToken('')).toBe('')
  })
})

describe('stripProjectTokens', () => {
  it('pulls out the scope and keeps everything else in order', () => {
    expect(stripProjectTokens('epic @rc #wip')).toEqual({ kept: ['epic', '#wip'], had: 'rc' })
  })

  it('leaves an exclusion alone -- `-@x` is not a scope', () => {
    expect(stripProjectTokens('-@anvil')).toEqual({ kept: ['-@anvil'], had: null })
  })

  it('leaves a quoted literal alone -- `"@x"` is free text', () => {
    expect(stripProjectTokens('"@anvil"')).toEqual({ kept: ['"@anvil"'], had: null })
  })

  it('leaves a bare `@` alone -- the parser reads it as free text', () => {
    expect(stripProjectTokens('@')).toEqual({ kept: ['@'], had: null })
  })

  it('reports the last scope when the user typed two', () => {
    expect(stripProjectTokens('@a @b').had).toBe('b')
  })
})

describe('the raw-string editors', () => {
  it('replaces rather than appends', () => {
    expect(withProject('epic @rc', 'anvil')).toBe('epic @anvil')
  })

  it('clears on null', () => {
    expect(withProject('epic @rc #wip', null)).toBe('epic #wip')
  })

  it('toggles the same project off and a different one on', () => {
    expect(toggledProject('epic @rc', 'rc')).toBe('epic')
    expect(toggledProject('epic @rc', 'anvil')).toBe('epic @anvil')
    expect(toggledProject('epic', 'rc')).toBe('epic @rc')
  })
})

describe('the store', () => {
  it('keeps raw and query in step', () => {
    store().setRaw('epic @rc %70')
    expect(store().raw).toBe('epic @rc %70')
    expect(store().query.text).toBe('epic')
    expect(store().query.project).toBe('rc')
    expect(store().query.minContextPct).toBe(70)
  })

  it('holds the query identity stable across a no-op write', () => {
    store().setRaw('@rc')
    const first = store().query
    store().setRaw('@rc')
    expect(store().query).toBe(first)
  })

  it('produces a new query object for a real write', () => {
    store().setRaw('@rc')
    const first = store().query
    store().setRaw('@anvil')
    expect(store().query).not.toBe(first)
  })

  it('round-trips the chip action: set, then clear', () => {
    store().toggleProject('remote-claude')
    expect(store().raw).toBe('@remote-claude')
    expect(selectWallProject(store())).toBe('remote-claude')

    store().toggleProject('remote-claude')
    expect(store().raw).toBe('')
    expect(selectWallProject(store())).toBeNull()
  })

  it('swaps projects rather than stacking them', () => {
    store().toggleProject('remote-claude')
    store().toggleProject('anvil')
    expect(store().raw).toBe('@anvil')
    expect(selectWallProject(store())).toBe('anvil')
  })

  it('leaves the rest of a typed query intact when a chip is clicked', () => {
    store().setRaw('ceiling #wip %70')
    store().toggleProject('remote-claude')
    expect(store().raw).toBe('ceiling #wip %70 @remote-claude')
    store().toggleProject('remote-claude')
    expect(store().raw).toBe('ceiling #wip %70')
    expect(store().query.minContextPct).toBe(70)
  })

  it('setProject sets and clears without toggling', () => {
    store().setProject('rc')
    store().setProject('rc')
    expect(store().raw).toBe('@rc')
    store().setProject(null)
    expect(store().raw).toBe('')
  })

  it('clear empties the box', () => {
    store().setRaw('epic @rc')
    store().clear()
    expect(store().raw).toBe('')
    expect(selectWallProject(store())).toBeNull()
  })
})

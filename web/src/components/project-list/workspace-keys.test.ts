// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { Workspace } from '@/lib/types'
import { buildWorkspaceBindings, positionalWorkspaceKey } from './workspace-hooks'

const ws = (id: string, key?: string): Workspace => ({ id, name: id, ...(key ? { key } : {}) })

describe('positionalWorkspaceKey', () => {
  it('gives the first workspace Ctrl+2 -- slot 1 belongs to the All view', () => {
    expect(positionalWorkspaceKey(0)).toBe('ctrl+2')
    expect(positionalWorkspaceKey(7)).toBe('ctrl+9')
  })

  it('runs out past the ninth slot rather than inventing a binding', () => {
    expect(positionalWorkspaceKey(8)).toBeNull()
  })
})

describe('buildWorkspaceBindings', () => {
  it('always registers all nine positional slots', () => {
    const keys = Object.keys(buildWorkspaceBindings([]))
    expect(keys).toEqual(['ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5', 'ctrl+6', 'ctrl+7', 'ctrl+8', 'ctrl+9'])
  })

  it('adds a custom key ALONGSIDE the positional defaults', () => {
    const bindings = buildWorkspaceBindings([ws('a', 'mod+shift+w'), ws('b')])
    expect(bindings['mod+shift+w']).toBeDefined()
    expect(bindings['ctrl+2']).toBeDefined()
  })

  it('supports a chord as a custom key', () => {
    expect(buildWorkspaceBindings([ws('a', 'mod+g w')])['mod+g w']).toBeDefined()
  })

  it('lets a custom key OVERRIDE a positional slot it collides with', () => {
    // Reordering renumbers the positional slots; an explicit key must not be
    // shadowed by whichever workspace happens to land on that number.
    const positional = buildWorkspaceBindings([])['ctrl+3']
    const overridden = buildWorkspaceBindings([ws('a'), ws('b', 'ctrl+3')])['ctrl+3']
    expect(overridden).not.toBe(positional)
  })
})

import { describe, expect, test } from 'bun:test'
import { type Binding, callBody, findCollisions, formatCollisions, scanBindings } from './shortcut-scan'

/**
 * REGRESSION (2026-08-18): Pulse shipped on `mod+k p`, already owned by the
 * Kanban board. Nothing caught it. These tests pin the static gate that now
 * does -- including the two things that make the scan non-trivial: parens
 * inside string literals, and useChordCommand registering TWO leaders per key.
 */

const b = (shortcut: string, commandId: string): Binding => ({ shortcut, commandId, file: 'f.ts', line: 1 })

describe('callBody', () => {
  test('captures a balanced call', () => {
    expect(callBody('useCommand(a, b)', 10)).toBe('(a, b)')
  })

  test('is not fooled by a paren inside a string literal', () => {
    const src = `useCommand('x', f, { label: 'Close ) paren' })`
    expect(callBody(src, 10)).toBe(`('x', f, { label: 'Close ) paren' })`)
  })

  test('handles nested calls', () => {
    expect(callBody('useCommand(f(g(1)), 2)', 10)).toBe('(f(g(1)), 2)')
  })

  test('handles escaped quotes', () => {
    const src = `useCommand('it\\'s', f)`
    expect(callBody(src, 10).endsWith(')')).toBe(true)
  })
})

describe('scanBindings', () => {
  test('reads a plain shortcut', () => {
    const found = scanBindings(`useCommand('open-switcher', fn, { shortcut: 'mod+p', group: 'Nav' })`)
    expect(found).toEqual([{ shortcut: 'mod+p', commandId: 'open-switcher', file: '<source>', line: 1 }])
  })

  test('expands a chord key across BOTH leaders it registers', () => {
    const found = scanBindings(`useChordCommand('open-pulse', fn, { label: 'Pulse', key: 'a' })`)
    expect(found.map(f => f.shortcut).sort()).toEqual(['mod+g a', 'mod+k a'])
    expect(new Set(found.map(f => f.commandId))).toEqual(new Set(['open-pulse']))
  })

  test('ignores a command with no binding', () => {
    expect(scanBindings(`useCommand('no-keys', fn, { label: 'x', group: 'Nav' })`)).toEqual([])
  })

  test('finds several declarations across a multi-line file', () => {
    const src = [
      `useCommand('a', fn, { shortcut: 'mod+p' })`,
      ``,
      `useChordCommand('b', fn, {`,
      `  label: 'B',`,
      `  key: 'z',`,
      `})`,
    ].join('\n')
    const found = scanBindings(src)
    expect(found.map(f => f.shortcut).sort()).toEqual(['mod+g z', 'mod+k z', 'mod+p'])
  })

  test('records the declaration line', () => {
    const src = `\n\nuseCommand('a', fn, { shortcut: 'mod+p' })`
    expect(scanBindings(src)[0].line).toBe(3)
  })

  test('survives an options object written across lines with a paren in a label', () => {
    const src = `useChordCommand(\n  'c',\n  fn,\n  { label: 'Fork (copy)', key: 'f' },\n)`
    expect(
      scanBindings(src)
        .map(f => f.shortcut)
        .sort(),
    ).toEqual(['mod+g f', 'mod+k f'])
  })
})

describe('findCollisions', () => {
  test('THE BUG: flags two commands on the identical chord', () => {
    const found = findCollisions([b('mod+k p', 'open-pulse'), b('mod+k p', 'open-project')])
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('duplicate')
    expect(found[0].shortcut).toBe('mod+k p')
  })

  test('does not flag a lone binding', () => {
    expect(findCollisions([b('mod+k p', 'open-project')])).toEqual([])
  })

  test('does not flag the -legacy twin as a second command', () => {
    expect(findCollisions([b('mod+k a', 'open-pulse'), b('mod+k a', 'open-pulse-legacy')])).toEqual([])
  })

  test('flags a prefix conflict', () => {
    const found = findCollisions([b('mod+g s', 'spawn'), b('mod+g s e', 'spawn-env')])
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('prefix')
  })

  test('does not treat a shared leader as a prefix conflict', () => {
    expect(findCollisions([b('mod+k p', 'a'), b('mod+k s', 'c')])).toEqual([])
  })

  test('does not false-positive on a common string prefix at a non-chord boundary', () => {
    expect(findCollisions([b('mod+k s', 'a'), b('mod+k se', 'c')])).toEqual([])
  })

  test('respects the baseline for pre-existing collisions', () => {
    const bindings = [b('mod+g n', 'notifications'), b('mod+g n', 'quick-task')]
    expect(findCollisions(bindings)).toHaveLength(1)
    expect(findCollisions(bindings, { duplicates: new Set(['mod+g n']) })).toEqual([])
  })

  test('a baselined shortcut does not mask a DIFFERENT collision', () => {
    const found = findCollisions(
      [b('mod+g n', 'notifications'), b('mod+g n', 'quick-task'), b('mod+k p', 'a'), b('mod+k p', 'c')],
      {
        duplicates: new Set(['mod+g n']),
      },
    )
    expect(found.map(f => f.shortcut)).toEqual(['mod+k p'])
  })

  test('reports a 3-way collision once, listing all three', () => {
    const found = findCollisions([b('mod+k x', 'a'), b('mod+k x', 'c'), b('mod+k x', 'd')])
    expect(found).toHaveLength(1)
    expect(found[0].kind === 'duplicate' && found[0].bindings).toHaveLength(3)
  })
})

describe('formatCollisions', () => {
  test('names the binding and every claimant', () => {
    const out = formatCollisions(findCollisions([b('mod+k p', 'open-pulse'), b('mod+k p', 'open-project')]))
    expect(out).toContain('DUPLICATE')
    expect(out).toContain('mod+k p')
    expect(out).toContain('open-pulse')
    expect(out).toContain('open-project')
  })

  test('explains that a shadowed binding can never fire', () => {
    const out = formatCollisions(findCollisions([b('mod+g s', 'spawn'), b('mod+g s e', 'spawn-env')]))
    expect(out).toContain('can never fire')
  })
})

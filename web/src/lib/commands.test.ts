import { describe, expect, it } from 'vitest'
import { describeChordConflict, findChordConflicts } from './commands'

/**
 * REGRESSION (2026-08-18): Pulse shipped on `mod+k p`, a chord `open-project`
 * (Kanban) already owned, and nothing complained. validateChordBindings only
 * looked for PREFIX conflicts, so two commands claiming the IDENTICAL binding
 * were silently accepted and the winner decided by registration order.
 *
 * findChordConflicts is the pure core, tested directly so the detection logic
 * doesn't need a populated module-singleton registry to exercise.
 */
const cmd = (id: string, shortcut: string, label = id) => ({ id, shortcut, label })

describe('findChordConflicts — duplicates', () => {
  it('flags two commands on the exact same chord', () => {
    const conflicts = findChordConflicts([cmd('open-pulse', 'mod+k p'), cmd('open-project', 'mod+k p')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('duplicate')
    expect(conflicts[0].binding).toBe('mod+k p')
    expect(conflicts[0].commands.map(c => c.id).sort()).toEqual(['open-project', 'open-pulse'])
  })

  it('flags duplicates on plain (non-chord) shortcuts too', () => {
    const conflicts = findChordConflicts([cmd('a', 'mod+p'), cmd('b', 'mod+p')])
    expect(conflicts.map(c => c.kind)).toEqual(['duplicate'])
  })

  it('does NOT flag a command against itself', () => {
    expect(findChordConflicts([cmd('solo', 'mod+k p')])).toEqual([])
  })

  it('does NOT flag the -legacy twin useChordCommand registers', () => {
    // useChordCommand registers `<id>` and `<id>-legacy` on two leaders; they
    // are one command wearing two bindings, not a collision.
    const conflicts = findChordConflicts([cmd('open-pulse', 'mod+k a'), cmd('open-pulse-legacy', 'mod+k a')])
    expect(conflicts).toEqual([])
  })

  it('ignores commands with no shortcut', () => {
    expect(
      findChordConflicts([
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ]),
    ).toEqual([])
  })

  it('reports each colliding binding once, not once per participant', () => {
    const conflicts = findChordConflicts([cmd('a', 'mod+k x'), cmd('b', 'mod+k x'), cmd('c', 'mod+k x')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].commands).toHaveLength(3)
  })
})

describe('describeChordConflict', () => {
  // A warning that says the wrong thing is worse than no warning.
  const raw = (s: string) => s

  it('names every claimant of a duplicate and says the last one wins', () => {
    const [conflict] = findChordConflicts([
      cmd('open-pulse', 'mod+k p', 'Pulse'),
      cmd('open-project', 'mod+k p', 'Kanban'),
    ])
    const text = describeChordConflict(conflict, raw)
    expect(text).toContain('mod+k p')
    expect(text).toContain('"Pulse"')
    expect(text).toContain('"Kanban"')
    expect(text).toContain('last one registered')
  })

  it('says a shadowed binding only fires on timeout', () => {
    const [conflict] = findChordConflicts([
      cmd('spawn', 'mod+g s', 'Spawn'),
      cmd('spawn-env', 'mod+g s e', 'Spawn w/ env'),
    ])
    const text = describeChordConflict(conflict, raw)
    expect(text).toContain('"Spawn"')
    expect(text).toContain('prefix of')
    expect(text).toContain('mod+g s e')
    expect(text).toContain('timeout')
  })

  it('runs the binding through the supplied formatter', () => {
    const [conflict] = findChordConflicts([cmd('a', 'mod+k p'), cmd('b', 'mod+k p')])
    expect(describeChordConflict(conflict, () => 'FORMATTED')).toContain('FORMATTED')
  })
})

describe('findChordConflicts — prefixes', () => {
  it('still flags a binding shadowed by a longer chord', () => {
    const conflicts = findChordConflicts([cmd('spawn', 'mod+g s'), cmd('spawn-env', 'mod+g s e')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('prefix')
    expect(conflicts[0].binding).toBe('mod+g s')
  })

  it('does not treat a shared leader as a prefix conflict', () => {
    // `mod+k p` and `mod+k s` share a leader but neither shadows the other.
    expect(findChordConflicts([cmd('a', 'mod+k p'), cmd('b', 'mod+k s')])).toEqual([])
  })

  it('does not false-positive on a common string prefix that is not a chord boundary', () => {
    // "mod+k s" must not be treated as a prefix of "mod+k something".
    expect(findChordConflicts([cmd('a', 'mod+k s'), cmd('b', 'mod+k se')])).toEqual([])
  })

  it('finds both kinds in one pass', () => {
    const conflicts = findChordConflicts([
      cmd('a', 'mod+k p'),
      cmd('b', 'mod+k p'),
      cmd('c', 'mod+g s'),
      cmd('d', 'mod+g s e'),
    ])
    expect(conflicts.map(c => c.kind).sort()).toEqual(['duplicate', 'prefix'])
  })

  it('is clean on a realistic non-colliding set', () => {
    expect(
      findChordConflicts([
        cmd('palette', 'mod+p'),
        cmd('pulse', 'mod+k a'),
        cmd('kanban', 'mod+k p'),
        cmd('canvas', 'mod+k c'),
      ]),
    ).toEqual([])
  })
})

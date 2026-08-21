import { describe, expect, test } from 'bun:test'
import {
  archiveCold,
  flagDuplicate,
  isExecutable,
  noteDeleteAt,
  PROPOSAL_DEFAULT_CHECKED,
  PROPOSAL_KINDS,
  promoteDelivered,
} from './board-sweep-proposals'

describe('the two invariants that must survive a refactor', () => {
  test('flag-duplicate can never be constructed ticked', () => {
    const p = flagDuplicate({ card: 'a', other: 'b', confidence: 0.9, reason: 'same ask' })
    expect(p.checked).toBe(false)
  })

  test('note-delete-at is unticked AND not executable -- unticked can be ticked, this cannot', () => {
    const p = noteDeleteAt({ card: 'a', deleteAt: '2026-01-01T00:00:00Z', elapsedDays: 3 })
    expect(p.checked).toBe(false)
    expect(p.executable).toBe(false)
    expect(isExecutable(p)).toBe(false)
  })

  test('the three reversible kinds are executable', () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(isExecutable({ kind })).toBe(kind !== 'note-delete-at')
    }
  })
})

describe('the defaults table is the same rule the constructors use', () => {
  test('every kind has an entry', () => {
    expect(Object.keys(PROPOSAL_DEFAULT_CHECKED).sort()).toEqual([...PROPOSAL_KINDS].sort())
  })

  test('each constructor agrees with the table', () => {
    const built = [
      promoteDelivered({ card: 'a', from: 'open', closes: ['abc1234'] }),
      archiveCold({ card: 'b', created: '2026-01-01T00:00:00Z', ageDays: 90 }),
      flagDuplicate({ card: 'c', other: 'd', confidence: 0.5, reason: 'x' }),
      noteDeleteAt({ card: 'e', deleteAt: '2026-01-01T00:00:00Z', elapsedDays: 1 }),
    ]
    for (const p of built) expect(p.checked).toBe(PROPOSAL_DEFAULT_CHECKED[p.kind])
  })
})

describe('a proposal shows its own workings', () => {
  test('promote-delivered names the commits and the lane it would leave', () => {
    const p = promoteDelivered({ card: 'a', from: 'in-review', closes: ['abc1234', 'def5678'] })
    expect(p.from).toBe('in-review')
    expect(p.to).toBe('done')
    expect(p.closes).toEqual(['abc1234', 'def5678'])
    expect(p.detail).toContain('abc1234')
  })

  test('archive-cold echoes created, never an mtime', () => {
    const p = archiveCold({ card: 'b', created: '2026-01-01T00:00:00Z', ageDays: 90 })
    expect(p.detail).toContain('2026-01-01T00:00:00Z')
    expect(p.detail).toContain('90d')
  })

  test('closes is copied, so a later mutation of the promise row cannot rewrite a proposal', () => {
    const closes = ['abc1234']
    const p = promoteDelivered({ card: 'a', from: 'open', closes })
    closes.push('deadbee')
    expect(p.closes).toEqual(['abc1234'])
  })
})

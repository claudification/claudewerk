import { describe, expect, it } from 'vitest'
import { nextComments } from './use-diagram-comments'

describe('nextComments', () => {
  it('adds a note to an empty set', () => {
    expect(nextComments(undefined, 'A', 'make clearer')).toEqual({ A: 'make clearer' })
  })

  it('adds a second note without dropping the first', () => {
    expect(nextComments({ A: 'one' }, 'B', 'two')).toEqual({ A: 'one', B: 'two' })
  })

  it('overwrites an existing note for the same node', () => {
    expect(nextComments({ A: 'old' }, 'A', 'new')).toEqual({ A: 'new' })
  })

  it('removes a note when cleared (empty / whitespace)', () => {
    expect(nextComments({ A: 'one', B: 'two' }, 'B', '')).toEqual({ A: 'one' })
    expect(nextComments({ A: 'one', B: 'two' }, 'B', '   ')).toEqual({ A: 'one' })
  })

  it('collapses to undefined when the last note is removed (clean payload)', () => {
    expect(nextComments({ A: 'only' }, 'A', '')).toBeUndefined()
  })

  it('clearing a missing node on an empty set stays undefined', () => {
    expect(nextComments(undefined, 'A', '')).toBeUndefined()
  })

  it('does not mutate the previous object', () => {
    const prev = { A: 'one' }
    nextComments(prev, 'B', 'two')
    expect(prev).toEqual({ A: 'one' })
  })
})

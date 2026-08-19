/**
 * A `Read` row claims how much of the file it saw. Getting it wrong is quietly
 * bad: "1,200 lines" on a 40-line window reads as "the agent has the whole
 * file" when it does not.
 */

import { describe, expect, test } from 'vitest'
import { readExtent } from './read-details'

describe('readExtent', () => {
  test('says nothing when the tool reported no line counts', () => {
    expect(readExtent({})).toBeNull()
    expect(readExtent({ startLine: 40, numLines: 10 })).toBeNull()
  })

  test('a whole-file read is a size, not a range', () => {
    expect(readExtent({ startLine: 1, numLines: 120, totalLines: 120 })).toEqual({ kind: 'total', total: 120 })
  })

  test('a window names both of its ends', () => {
    expect(readExtent({ startLine: 400, numLines: 40, totalLines: 2000 })).toEqual({
      kind: 'range',
      start: 400,
      end: 439,
      total: 2000,
    })
  })

  test('a head read of a longer file is still a window', () => {
    expect(readExtent({ startLine: 1, numLines: 40, totalLines: 2000 })).toMatchObject({ kind: 'range', end: 40 })
  })

  test('an offset with no line count falls back to the total', () => {
    expect(readExtent({ startLine: 400, totalLines: 2000 })).toEqual({ kind: 'total', total: 2000 })
  })
})

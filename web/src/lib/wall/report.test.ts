import { describe, expect, test } from 'vitest'
import { reportMore, reportParens, reportRow, wallReport, wallReportStamp } from './report'

describe('wallReportStamp -- a pasted report says what it was a view OF', () => {
  test('live and unfiltered is the plain case', () => {
    expect(wallReportStamp({ offsetMs: 0, filter: '' })).toBe('as of now')
  })

  test('a rewound cursor is carried, in the header offset format', () => {
    expect(wallReportStamp({ offsetMs: 42 * 60_000, filter: '' })).toBe('as of T-42m')
  })

  test('the filter is carried VERBATIM -- it is what the reader has to re-type', () => {
    expect(wallReportStamp({ offsetMs: 0, filter: '@anvil +over' })).toBe('as of now · filter: @anvil +over')
  })

  test('a whitespace-only box is not a filter', () => {
    expect(wallReportStamp({ offsetMs: 0, filter: '   ' })).toBe('as of now')
  })

  test('both, together -- the case a paste cannot be read without', () => {
    expect(wallReportStamp({ offsetMs: 90 * 60_000, filter: '@anvil' })).toBe('as of T-1h30m · filter: @anvil')
  })
})

describe('wallReport -- head, body, and the empty case', () => {
  const view = { offsetMs: 0, filter: '' }

  test('stamps the head with the title and the reference code', () => {
    expect(wallReport({ title: 'PULSE', code: 'P1', lines: ['a'], ...view })).toBe('PULSE (P1) -- as of now\na')
  })

  test('flattens nested lines, so a builder can emit a row plus its children', () => {
    const text = wallReport({ title: 'PINNED', code: 'A8', lines: [['epic', '  child']], ...view })
    expect(text.split('\n').slice(1)).toEqual(['epic', '  child'])
  })

  test('drops absent lines rather than pasting a hole', () => {
    const text = wallReport({ title: 'X', code: 'X1', lines: ['a', null, '', undefined, 'b'], ...view })
    expect(text.split('\n').slice(1)).toEqual(['a', 'b'])
  })

  test('an empty pane REPORTS its own silence -- a bare head reads as a broken button', () => {
    const text = wallReport({
      title: 'BLOCKED ON YOU',
      code: 'A1',
      lines: [],
      empty: 'nobody is waiting on you',
      ...view,
    })
    expect(text).toBe('BLOCKED ON YOU (A1) -- as of now\nnobody is waiting on you')
  })
})

describe('the row helpers -- an absent fact is an absent FIELD, never a gap', () => {
  test('reportRow drops what is not there', () => {
    expect(reportRow('a', null, undefined, false, '', 'b')).toBe('a  b')
  })

  test('reportParens keeps the brackets honest', () => {
    expect(reportParens('4m', null, 'studio')).toBe('(4m, studio)')
  })

  test('reportParens with nothing to say says nothing -- not `()`', () => {
    expect(reportParens(null, undefined, '')).toBeNull()
  })

  test('reportMore is silent at zero and loud above it', () => {
    expect(reportMore(0, 'hidden')).toBeNull()
    expect(reportMore(3, 'hidden')).toBe('+ 3 hidden')
  })
})

import { describe, expect, it } from 'vitest'
import { buildCanvasRef, matchLeadingCanvasRef, parseCanvasRefs } from './canvas-refs'

describe('canvas-refs', () => {
  it('round-trips build -> parse', () => {
    const tok = buildCanvasRef('cnv_1', 'arch sketch')
    expect(tok).toBe('<canvas id="cnv_1">arch sketch</canvas>')
    const refs = parseCanvasRefs(`hey ${tok} look`)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ id: 'cnv_1', label: 'arch sketch' })
    expect(`hey ${tok} look`.slice(refs[0].start, refs[0].end)).toBe(tok)
  })

  it('parses multiple refs in order', () => {
    const text = `${buildCanvasRef('a', 'A')} and ${buildCanvasRef('b', 'B')}`
    expect(parseCanvasRefs(text).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('matchLeadingCanvasRef only matches at the start', () => {
    expect(matchLeadingCanvasRef(buildCanvasRef('x', 'X') + ' tail')?.id).toBe('x')
    expect(matchLeadingCanvasRef(`pre ${buildCanvasRef('x', 'X')}`)).toBeNull()
  })

  it('a name with a < cannot swallow following content', () => {
    // The body forbids `<`, so a malformed token does not match greedily.
    expect(parseCanvasRefs('<canvas id="a">x < y</canvas>')).toHaveLength(0)
  })
})

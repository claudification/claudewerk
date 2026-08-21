/**
 * THE `when` AXIS CODEC.
 *
 * The interesting cases are all about what an OLDER artifact says: every `run.md`
 * on disk was written when this field could only hold one value, and a parse that
 * lost `window` there would dispatch a night run at noon.
 */

import { describe, expect, it } from 'bun:test'
import { formatWhen, gatedBy, parseWhen, serializeWhen } from './epic-when'

describe('parseWhen', () => {
  it('reads the bare scalar every pre-existing run.md carries', () => {
    expect(parseWhen('window')).toEqual(['window'])
    expect(parseWhen('now')).toEqual(['now'])
  })

  it('defaults to no gate when the field is absent or unreadable', () => {
    expect(parseWhen(undefined)).toEqual(['now'])
    expect(parseWhen('')).toEqual(['now'])
    expect(parseWhen('tuesday')).toEqual(['now'])
  })

  it('reads a real list and a joined string the same way', () => {
    expect(parseWhen(['window', 'queue'])).toEqual(['window', 'queue'])
    expect(parseWhen('window,queue')).toEqual(['window', 'queue'])
    expect(parseWhen('queue + window')).toEqual(['window', 'queue'])
  })

  it('normalises to a canonical order, so one axis has one spelling', () => {
    expect(parseWhen(['queue', 'window'])).toEqual(parseWhen(['window', 'queue']))
  })

  it('drops `now` when a real gate rides with it -- `now` IS the absence of one', () => {
    expect(parseWhen(['now', 'queue'])).toEqual(['queue'])
  })

  it('dedupes rather than gating twice on the same thing', () => {
    expect(parseWhen('queue,queue')).toEqual(['queue'])
  })
})

describe('serializeWhen', () => {
  it('writes a lone gate as a bare scalar, so old artifacts keep their bytes', () => {
    expect(serializeWhen(['window'])).toBe('window')
    expect(serializeWhen(['now'])).toBe('now')
  })

  it('writes a real list only when there is one', () => {
    expect(serializeWhen(['window', 'queue'])).toEqual(['window', 'queue'])
  })

  it('round-trips', () => {
    expect(parseWhen(serializeWhen(['window', 'queue']))).toEqual(['window', 'queue'])
    expect(parseWhen(serializeWhen(['queue']))).toEqual(['queue'])
  })
})

describe('gatedBy / formatWhen', () => {
  it('answers per gate rather than by string comparison on the whole axis', () => {
    expect(gatedBy(['window', 'queue'], 'queue')).toBe(true)
    expect(gatedBy(['window'], 'queue')).toBe(false)
    expect(gatedBy(undefined, 'queue')).toBe(false)
  })

  /**
   * VERSION SKEW. Broker and sentinel deploy separately, so a run snapshot can
   * arrive with `cadence` as the bare string it was before this field could hold
   * a list. Both readers must answer about it correctly rather than by whatever
   * `String.prototype.includes` happens to say.
   */
  it('takes the wire value in the shape an OLDER sentinel sends it', () => {
    expect(gatedBy('window' as never, 'window')).toBe(true)
    expect(gatedBy('window' as never, 'queue')).toBe(false)
    expect(gatedBy('now' as never, 'now')).toBe(true)
    expect(formatWhen('window' as never)).toBe('window')
  })

  it('reads as one phrase for a human', () => {
    expect(formatWhen(['window', 'queue'])).toBe('window + queue')
    expect(formatWhen(['now'])).toBe('now')
  })
})

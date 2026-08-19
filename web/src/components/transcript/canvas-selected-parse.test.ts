/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { canvasIdFromChannelAddress, parseCanvasMessage } from './canvas-selected-parse'

const REAL = `  <selected id="ytaVE08zkjStV5v9EwZI2" type="rectangle" stroke="#1971c2" fill="#ffc9c9" at="356,544" size="207x82">CLAUDE</selected>
make sense of this scene :-).. just tell the user in the main chat - don't change here..`

describe('parseCanvasMessage', () => {
  test('lifts a selected element out of the body and keeps the words', () => {
    const out = parseCanvasMessage(REAL)
    expect(out.text).toBe("make sense of this scene :-).. just tell the user in the main chat - don't change here..")
    expect(out.chips).toEqual([
      { id: 'ytaVE08zkjStV5v9EwZI2', type: 'rectangle', label: 'CLAUDE', stroke: '#1971c2', fill: '#ffc9c9' },
    ])
  })

  test('an element with no text has no label', () => {
    const out = parseCanvasMessage('  <selected id="a1" type="ellipse"></selected>\nlook')
    expect(out.chips[0]).toEqual({ id: 'a1', type: 'ellipse', label: undefined, stroke: undefined, fill: undefined })
    expect(out.text).toBe('look')
  })

  test('several selected lines all become chips', () => {
    const out = parseCanvasMessage(
      '  <selected id="a" type="rectangle">One</selected>\n  <selected id="b" type="arrow"></selected>\nmove these',
    )
    expect(out.chips.map(c => c.id)).toEqual(['a', 'b'])
    expect(out.text).toBe('move these')
  })

  test('a truncated selection is a census, not chips', () => {
    const out = parseCanvasMessage('  <selected count="42" summary="30 rectangle, 12 arrow" />\ntidy this up')
    expect(out.census).toEqual({ count: 42, summary: '30 rectangle, 12 arrow' })
    expect(out.chips).toEqual([])
    expect(out.text).toBe('tidy this up')
  })

  test('a message with no selection is left completely alone', () => {
    const body = 'just talking, nothing selected'
    expect(parseCanvasMessage(body)).toEqual({ text: body, chips: [], census: undefined })
  })

  test('escaped text comes back unescaped', () => {
    const out = parseCanvasMessage('  <selected id="a" type="text">a &amp; b &quot;c&quot;</selected>\nhi')
    expect(out.chips[0].label).toBe('a & b "c"')
  })

  test('a malformed line is dropped, not printed at the user', () => {
    const out = parseCanvasMessage('  <selected type="rectangle"></selected>\nhi')
    expect(out.chips).toEqual([])
    expect(out.text).toBe('hi')
  })
})

describe('canvasIdFromChannelAddress', () => {
  test('reads the id out of the canvas sink address', () => {
    expect(canvasIdFromChannelAddress('canvas:cnv_6ec4c5e2')).toBe('cnv_6ec4c5e2')
  })

  test('is null for anything that is not a canvas', () => {
    expect(canvasIdFromChannelAddress('orb:abc')).toBeNull()
    expect(canvasIdFromChannelAddress(undefined)).toBeNull()
  })
})

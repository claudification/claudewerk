/**
 * The bus P4 and A2 copy THROUGH, and the two rules that keep it honest:
 * a reading is what the tile rendered, and unmounting clears the slot.
 *
 * The second one is the one with teeth. A tile the filter removed that left its
 * last number behind would put a value in the report that is not on screen --
 * the same phantom the wall's staleness contract exists to refuse, arriving
 * through the clipboard instead of the DOM.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWallReadings, usePublishReading, wallReading, wallReadings } from './wall-reading-bus'

function Tile({ id, label, value }: { id: string; label: string; value: string | null }) {
  usePublishReading(id, { label, value })
  return <span>{value ?? '—'}</span>
}

beforeEach(clearWallReadings)
afterEach(cleanup)

describe('wall-reading-bus', () => {
  it('publishes what a mounted tile is showing', () => {
    render(<Tile id="p4-TOKENS/MIN" label="TOKENS/MIN" value="12.4k" />)
    expect(wallReading('p4-TOKENS/MIN')).toEqual({ label: 'TOKENS/MIN', value: '12.4k' })
  })

  it('keeps a DASH a dash -- an unfed tile must not report a zero', () => {
    render(<Tile id="p4-WS RTT" label="WS RTT" value={null} />)
    expect(wallReading('p4-WS RTT')?.value).toBeNull()
  })

  it('CLEARS the slot on unmount, so a filtered-away tile leaves no phantom', () => {
    const view = render(<Tile id="p4-HOSTS UP" label="HOSTS UP" value="6" />)
    expect(wallReading('p4-HOSTS UP')).toBeTruthy()
    view.unmount()
    expect(wallReading('p4-HOSTS UP')).toBeNull()
  })

  it("scopes by key prefix -- one pane never folds another pane's numbers", () => {
    render(
      <>
        <Tile id="p4-HOSTS UP" label="HOSTS UP" value="6" />
        <Tile id="a2-rate" label="RATE" value="$11.40/h" />
      </>,
    )
    expect(wallReadings('p4-').map(r => r.label)).toEqual(['HOSTS UP'])
    expect(wallReadings('a2-').map(r => r.label)).toEqual(['RATE'])
  })

  it('republishes in place when the value moves, rather than stacking entries', () => {
    const view = render(<Tile id="p4-TOKENS/MIN" label="TOKENS/MIN" value="12.4k" />)
    view.rerender(<Tile id="p4-TOKENS/MIN" label="TOKENS/MIN" value="13.1k" />)
    expect(wallReadings('p4-')).toEqual([{ label: 'TOKENS/MIN', value: '13.1k' }])
  })
})

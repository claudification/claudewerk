/**
 * above-viewport anchor -- batch compensation math.
 *
 * jsdom has no layout, so each box's post-layout rect is stubbed. That is
 * exactly the input the real ResizeObserver callback sees: LAYOUT IS ALREADY
 * FINAL when the callback runs, so a box's rect.top already includes the growth
 * of every earlier sibling in the same batch. The regression these tests lock
 * in is that we must undo that contamination before deciding whether the box
 * sat above the viewport.
 */

import { describe, expect, it } from 'vitest'
import { compensationForBatch, type ResizedBox } from './use-above-anchor'

/** A group box whose post-layout top edge is `top`. */
function box(top: number, newH: number): ResizedBox {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({ top, height: newH }) as DOMRect
  return { el, newH }
}

function heightsOf(...pairs: Array<[ResizedBox, number]>): WeakMap<Element, number> {
  const heights = new WeakMap<Element, number>()
  for (const [b, h] of pairs) heights.set(b.el, h)
  return heights
}

/** Boxes must be linked in document order for the sort to have anything to go
 *  on -- ResizeObserver delivers in observe() order, which the MutationObserver
 *  path makes diverge from document order. */
function inDocument(...boxes: ResizedBox[]): void {
  const parent = document.createElement('div')
  for (const b of boxes) parent.appendChild(b.el)
}

describe('compensationForBatch', () => {
  it('compensates a single box that grew fully above the viewport', () => {
    const a = box(-500, 800)
    inDocument(a)
    expect(compensationForBatch([a], heightsOf([a, 200]), 100)).toBe(600)
  })

  it('compensates EVERY above-viewport box in one batch (regression)', () => {
    // Scroller top edge at y=100. Pre-resize: A [-500,-300], B [-300,-100] --
    // both fully above. A grows 200->800 (+600), B grows 200->600 (+400).
    // Post-layout (what the callback sees): A [-500,300], B [300,900] -- B's
    // top was pushed down by A's 600. Naive code reads B's top as 300, decides
    // "not above the viewport", and drops B's 400px.
    const a = box(-500, 800)
    const b = box(300, 600)
    inDocument(a, b)
    expect(compensationForBatch([a, b], heightsOf([a, 200], [b, 200]), 100)).toBe(1000)
  })

  it('is order-independent (RO delivers in observe() order, not document order)', () => {
    const a = box(-500, 800)
    const b = box(300, 600)
    inDocument(a, b)
    expect(compensationForBatch([b, a], heightsOf([a, 200], [b, 200]), 100)).toBe(1000)
  })

  it('ignores a box that straddles the viewport top -- it is its own anchor', () => {
    // Pre-resize top -50, height 200 => bottom 150, below the scroller top 100.
    const a = box(-50, 600)
    inDocument(a)
    expect(compensationForBatch([a], heightsOf([a, 200]), 100)).toBe(0)
  })

  it('does not let a straddling box contaminate a later above-viewport box', () => {
    // A straddles (no compensation) but still pushes B down; B is below it, so
    // B is not above the viewport either. Nothing to compensate.
    const a = box(-50, 600)
    const b = box(550, 300)
    inDocument(a, b)
    expect(compensationForBatch([a, b], heightsOf([a, 200], [b, 200]), 100)).toBe(0)
  })

  it('records a baseline on first observation and compensates nothing', () => {
    const a = box(-500, 800)
    inDocument(a)
    const heights = new WeakMap<Element, number>()
    expect(compensationForBatch([a], heights, 100)).toBe(0)
    expect(heights.get(a.el)).toBe(800)
  })

  it('updates baselines for every box, including uncompensated ones', () => {
    const a = box(-500, 800)
    const b = box(300, 600)
    inDocument(a, b)
    const heights = heightsOf([a, 200], [b, 200])
    compensationForBatch([a, b], heights, 100)
    expect(heights.get(a.el)).toBe(800)
    expect(heights.get(b.el)).toBe(600)
  })

  it('compensates a shrink above the viewport negatively', () => {
    const a = box(-500, 120)
    inDocument(a)
    expect(compensationForBatch([a], heightsOf([a, 400]), 100)).toBe(-280)
  })
})

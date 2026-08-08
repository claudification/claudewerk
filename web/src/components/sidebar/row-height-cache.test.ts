import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetRowHeightCache,
  captureRowHeights,
  medianRowHeight,
  rememberRowHeight,
  reservedRowHeight,
} from './row-height-cache'

afterEach(() => {
  __resetRowHeightCache()
  document.body.innerHTML = ''
})

describe('reservedRowHeight', () => {
  it('falls back to the caller guess when nothing has been measured', () => {
    expect(reservedRowHeight('conv-a', 2.25)).toBe('auto 2.25rem')
  })

  it('uses a row own measured height once seen', () => {
    rememberRowHeight('conv-a', 41)
    expect(reservedRowHeight('conv-a', 2.25)).toBe('auto 41px')
  })

  // The point of the whole cache: an UNSEEN row should not reserve a flat guess
  // when its neighbours have already told us how tall rows really are. A wrong
  // reservation here is what makes scrollIntoView land and then get shoved off
  // target as the revealed rows inflate.
  it('estimates an unseen row from the median of the rows it has seen', () => {
    rememberRowHeight('conv-a', 40)
    rememberRowHeight('conv-b', 44)
    rememberRowHeight('conv-c', 42)
    expect(medianRowHeight()).toBe(42)
    expect(reservedRowHeight('never-rendered', 2.25)).toBe('auto 42px')
  })

  it('keeps the auto keyword so the browser still self-corrects after paint', () => {
    rememberRowHeight('conv-a', 41)
    expect(reservedRowHeight('conv-a', 2.25).startsWith('auto ')).toBe(true)
  })

  it('ignores zero and negative measurements', () => {
    rememberRowHeight('conv-a', 0)
    rememberRowHeight('conv-b', -5)
    expect(medianRowHeight()).toBeNull()
  })

  it('recomputes the median after a new measurement', () => {
    rememberRowHeight('conv-a', 10)
    expect(medianRowHeight()).toBe(10)
    rememberRowHeight('conv-b', 20)
    rememberRowHeight('conv-c', 30)
    expect(medianRowHeight()).toBe(20)
  })
})

describe('captureRowHeights', () => {
  function mountRows(rows: Array<{ id: string; top: number; height: number }>) {
    const root = document.createElement('div')
    root.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect
    for (const row of rows) {
      const el = document.createElement('div')
      el.dataset.conversationId = row.id
      el.getBoundingClientRect = () => ({ top: row.top, bottom: row.top + row.height, height: row.height }) as DOMRect
      root.appendChild(el)
    }
    document.body.appendChild(root)
    return root
  }

  it('records rows inside the scroll viewport', () => {
    captureRowHeights(mountRows([{ id: 'visible', top: 10, height: 40 }]))
    expect(reservedRowHeight('visible', 2.25)).toBe('auto 40px')
  })

  // A content-visibility-skipped row reports its RESERVED box, not a real
  // measurement. Recording one would launder a guess into the cache as truth,
  // and it would never self-correct because the guess is now "measured".
  it('skips rows outside the viewport, whose heights are reservations not measurements', () => {
    captureRowHeights(
      mountRows([
        { id: 'above', top: -400, height: 36 },
        { id: 'below', top: 900, height: 36 },
      ]),
    )
    expect(medianRowHeight()).toBeNull()
  })
})

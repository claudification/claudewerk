import { describe, expect, it } from 'bun:test'
import { orthogonalConnector } from './diagram-geometry'

describe('orthogonalConnector -- vertically separated boxes', () => {
  it('routes a straight vertical when the boxes are centre-aligned', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 })
    expect(c.points).toEqual([
      [50, 40],
      [50, 100],
    ])
    expect(c.mid).toEqual([50, 70])
  })

  it('elbows down-across-down when offset horizontally', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 120, y: 300, w: 100, h: 40 })
    expect(c.points).toHaveLength(4)
    expect(c.points[0]).toEqual([50, 40]) // bottom-centre of `from`
    expect(c.points[3]).toEqual([170, 300]) // top-centre of `to`
  })

  it('exits the TOP when the target sits above', () => {
    const c = orthogonalConnector({ x: 0, y: 300, w: 100, h: 40 }, { x: 0, y: 0, w: 100, h: 40 })
    expect(c.points[0]).toEqual([50, 300]) // top edge of `from`
    expect(c.points[c.points.length - 1]).toEqual([50, 40]) // bottom edge of `to`
  })
})

// The lane-to-lane case: boxes side by side. Routing them bottom -> top sent the
// connector on a detour UNDER both boxes; it has to leave the right edge and
// arrive at the left one.
describe('orthogonalConnector -- horizontally separated boxes', () => {
  it('routes a straight horizontal when the boxes are row-aligned', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 })
    expect(c.points).toEqual([
      [100, 20],
      [300, 20],
    ])
    expect(c.mid).toEqual([200, 20])
  })

  it('elbows across-down-across when the rows are offset', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 200, w: 100, h: 40 })
    expect(c.points).toHaveLength(4)
    expect(c.points[0]).toEqual([100, 20]) // right edge of `from`
    expect(c.points[3]).toEqual([300, 220]) // left edge of `to`
  })

  it('exits the LEFT edge when the target sits to the left', () => {
    const c = orthogonalConnector({ x: 300, y: 0, w: 100, h: 40 }, { x: 0, y: 0, w: 100, h: 40 })
    expect(c.points[0]).toEqual([300, 20])
    expect(c.points[c.points.length - 1]).toEqual([100, 20])
  })

  // The whole point: no segment may run through either box.
  it('never crosses either box', () => {
    const from = { x: 0, y: 0, w: 100, h: 40 }
    const to = { x: 300, y: 200, w: 100, h: 40 }
    const inside = (r: typeof from, [x, y]: number[]) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h
    for (const p of orthogonalConnector(from, to).points) {
      expect(inside(from, p)).toBe(false)
      expect(inside(to, p)).toBe(false)
    }
  })
})

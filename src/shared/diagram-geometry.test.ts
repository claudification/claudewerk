import { describe, expect, it } from 'bun:test'
import { orthogonalConnector } from './diagram-geometry'

describe('orthogonalConnector', () => {
  it('routes a straight vertical when the boxes are centre-aligned', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 })
    expect(c.points).toEqual([
      [50, 40],
      [50, 100],
    ])
    expect(c.mid).toEqual([50, 70])
  })

  it('elbows down-across-down when offset horizontally', () => {
    const c = orthogonalConnector({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 100, h: 40 })
    expect(c.points).toHaveLength(4)
    expect(c.points[0]).toEqual([50, 40]) // bottom-centre of `from`
    expect(c.points[3]).toEqual([250, 100]) // top-centre of `to`
    expect(c.mid).toEqual([150, 70]) // midway across the elbow's horizontal run
  })
})

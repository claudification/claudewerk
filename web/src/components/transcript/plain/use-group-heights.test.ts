/**
 * intrinsicStyle -- the per-group `contain-intrinsic-size` value.
 *
 * Two properties, both load-bearing:
 *  - IDENTITY is shared per bucket. A per-group inline style object minted
 *    fresh every render would make every group's props look new on every
 *    commit, which is how a non-virtualized list turns a keystroke into a
 *    full-transcript re-render.
 *  - The reserved height is never SHORT of the real one (round up). Under-
 *    reserving is the direction that shoves content into the reader's face.
 */

import { describe, expect, it } from 'vitest'
import { intrinsicStyle } from './use-group-heights'

describe('intrinsicStyle', () => {
  it('returns the SAME object for heights in one bucket', () => {
    expect(intrinsicStyle(401)).toBe(intrinsicStyle(408))
  })

  it('returns different objects across buckets', () => {
    expect(intrinsicStyle(100)).not.toBe(intrinsicStyle(900))
  })

  it('never reserves less than the requested height', () => {
    for (const px of [1, 17, 199, 200, 201, 733, 4001]) {
      const value = String(intrinsicStyle(px).containIntrinsicSize)
      expect(Number(value.replace(/\D+/g, ''))).toBeGreaterThanOrEqual(px)
    }
  })

  it('emits the auto keyword so a rendered box remembers its real height', () => {
    expect(intrinsicStyle(300).containIntrinsicSize).toMatch(/^auto \d+px$/)
  })

  it('honours an exact bucket of 1 (the flat lab knob)', () => {
    expect(intrinsicStyle(320, 1).containIntrinsicSize).toBe('auto 320px')
  })

  it('clamps absurd heights', () => {
    expect(intrinsicStyle(50_000).containIntrinsicSize).toBe('auto 8000px')
  })
})

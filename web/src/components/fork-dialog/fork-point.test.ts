import { describe, expect, it } from 'vitest'
import { type ForkPointSeed, PREVIEW_CHARS, previewText, toForkPointRequest } from './fork-point'

const seed = (over: Partial<ForkPointSeed> = {}): ForkPointSeed => ({
  uuid: 'cc-uuid-1',
  timestamp: '2026-08-19T10:00:00.000Z',
  role: 'user',
  preview: 'hello',
  ...over,
})

const opts = (over: Partial<Parameters<typeof toForkPointRequest>[1]> = {}) => ({
  direction: 'before' as const,
  inclusive: true,
  summarizeDropped: false,
  ...over,
})

describe('previewText', () => {
  it('collapses runs of whitespace into single spaces', () => {
    expect(previewText('a\n\n\tb   c')).toBe('a b c')
  })

  it('clips and marks a long string', () => {
    const out = previewText('y'.repeat(PREVIEW_CHARS + 50))
    expect(out.endsWith('...')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PREVIEW_CHARS + 3)
  })

  it('leaves a short string alone', () => {
    expect(previewText('short')).toBe('short')
  })
})

describe('toForkPointRequest', () => {
  it('is undefined with no seed -- that is a fork from HEAD', () => {
    expect(toForkPointRequest(undefined, opts())).toBeUndefined()
  })

  it('is undefined when the seed can locate nothing', () => {
    expect(toForkPointRequest(seed({ uuid: undefined, timestamp: undefined }), opts())).toBeUndefined()
  })

  it('carries uuid and timestamp together so the sentinel can fall back', () => {
    const req = toForkPointRequest(seed(), opts())
    expect(req?.uuid).toBe('cc-uuid-1')
    expect(req?.timestamp).toBe('2026-08-19T10:00:00.000Z')
  })

  it('passes direction and inclusivity straight through', () => {
    expect(toForkPointRequest(seed(), opts({ direction: 'after', inclusive: false }))).toMatchObject({
      direction: 'after',
      inclusive: false,
    })
  })

  it('summarizes the dropped slice for carry-AFTER when asked', () => {
    const req = toForkPointRequest(seed(), opts({ direction: 'after', summarizeDropped: true }))
    expect(req?.summarizeDropped).toBe(true)
  })

  it('NEVER summarizes for carry-BEFORE -- that slice is the future being redone', () => {
    const req = toForkPointRequest(seed(), opts({ direction: 'before', summarizeDropped: true }))
    expect(req?.summarizeDropped).toBe(false)
  })

  it('still builds a request from a timestamp-only seed', () => {
    const req = toForkPointRequest(seed({ uuid: undefined }), opts())
    expect(req?.uuid).toBeUndefined()
    expect(req?.timestamp).toBe('2026-08-19T10:00:00.000Z')
  })
})

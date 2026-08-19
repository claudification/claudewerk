import { describe, expect, it } from 'vitest'
import { PREVIEW_CHARS } from '../fork-dialog/fork-point'
import { buildForkPointSeed, canForkAtGroup } from './fork-point-seed'
import type { RenderItem } from './group-view-types'
import type { DisplayGroup } from './grouping'

const group = (over: Partial<DisplayGroup> = {}): DisplayGroup =>
  ({
    type: 'user',
    entries: [{ uuid: 'cc-uuid-1', timestamp: '2026-08-19T10:00:00.000Z' }],
    ...over,
  }) as unknown as DisplayGroup

const text = (t: string): RenderItem => ({ kind: 'text', text: t })

describe('canForkAtGroup', () => {
  it('accepts real turns', () => {
    expect(canForkAtGroup(group({ type: 'user' }))).toBe(true)
    expect(canForkAtGroup(group({ type: 'assistant' }))).toBe(true)
  })

  it('rejects chrome and synthetic groups', () => {
    for (const type of ['boot', 'launch', 'spawn_notification', 'shell', 'advisor', 'system'] as const) {
      expect(canForkAtGroup(group({ type }))).toBe(false)
    }
  })

  it('rejects group types it has never heard of -- allow-list, not deny-list', () => {
    for (const type of ['live', 'scrollback_spacer', 'compacted', 'skill', 'forked'] as const) {
      expect(canForkAtGroup(group({ type }))).toBe(false)
    }
  })
})

describe('buildForkPointSeed', () => {
  it('takes the boundary from the FIRST entry -- a turn is cut where it starts', () => {
    const seed = buildForkPointSeed(
      group({
        entries: [
          { uuid: 'first', timestamp: '2026-08-19T10:00:00.000Z' },
          { uuid: 'second', timestamp: '2026-08-19T10:00:05.000Z' },
        ] as unknown as DisplayGroup['entries'],
      }),
      [text('hello')],
    )
    expect(seed?.uuid).toBe('first')
    expect(seed?.timestamp).toBe('2026-08-19T10:00:00.000Z')
  })

  it('carries the timestamp alone when the entry has no CC uuid', () => {
    const seed = buildForkPointSeed(
      group({ entries: [{ timestamp: '2026-08-19T10:00:00.000Z' }] as unknown as DisplayGroup['entries'] }),
      [text('a voice prompt')],
    )
    expect(seed).not.toBeNull()
    expect(seed?.uuid).toBeUndefined()
    expect(seed?.timestamp).toBe('2026-08-19T10:00:00.000Z')
  })

  it('returns null when there is nothing to locate the boundary by', () => {
    expect(buildForkPointSeed(group({ entries: [{}] as unknown as DisplayGroup['entries'] }), [text('x')])).toBeNull()
  })

  it('returns null for an unforkable group even with a perfectly good uuid', () => {
    expect(buildForkPointSeed(group({ type: 'boot' }), [text('x')])).toBeNull()
  })

  it('labels the role so the dialog preview can say whose message it is', () => {
    expect(buildForkPointSeed(group({ type: 'user' }), [text('x')])?.role).toBe('user')
    expect(buildForkPointSeed(group({ type: 'assistant' }), [text('x')])?.role).toBe('assistant')
  })

  it('flattens whitespace and clips the preview', () => {
    const seed = buildForkPointSeed(group(), [text(`line one\n\n   line   two`)])
    expect(seed?.preview).toBe('line one line two')
  })

  it('clips a long message to the preview budget', () => {
    const seed = buildForkPointSeed(group(), [text('x'.repeat(PREVIEW_CHARS * 2))])
    expect(seed?.preview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 3)
    expect(seed?.preview.endsWith('...')).toBe(true)
  })

  it('names tools in the preview so a tool-only turn is still recognisable', () => {
    const seed = buildForkPointSeed(group({ type: 'assistant' }), [
      { kind: 'tool', tool: { name: 'Bash' } } as unknown as RenderItem,
    ])
    expect(seed?.preview).toBe('[Bash]')
  })

  it('survives a turn with no renderable text', () => {
    const seed = buildForkPointSeed(group(), [])
    expect(seed).not.toBeNull()
    expect(seed?.preview).toBe('')
  })
})

/**
 * Group box styling -- and the Safari-first decision baked into the defaults.
 *
 * `content-visibility: auto` is OFF by default and these tests are the guard
 * rail on that, because it looks like free performance and it is not. On WebKit
 * it buys skipped offscreen LAYOUT (never React work -- every windowed group is
 * in the DOM regardless) and charges: a reserved-height box that snaps to its
 * real height exactly as the reader scrolls up toward it, SVG text that never
 * paints (Mermaid -- https://adactio.com/journal/21498), and details/summary
 * that will not expand (https://bugs.webkit.org/show_bug.cgi?id=277573).
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAIN_RENDERER_LAB } from '@/lib/plain-renderer-lab'
import type { DisplayGroup } from '../grouping'
import { type BoxSizing, PlainGroupList } from './plain-group-list'

const GROUP: DisplayGroup = {
  type: 'compacted',
  timestamp: '2026-07-25T00:00:00.000Z',
  entries: [],
} as unknown as DisplayGroup

function boxes(overrides: Partial<BoxSizing> = {}): NodeListOf<HTMLElement> {
  const box: BoxSizing = {
    contentVisibility: DEFAULT_PLAIN_RENDERER_LAB.contentVisibility,
    sizing: DEFAULT_PLAIN_RENDERER_LAB.sizing,
    intrinsicSize: DEFAULT_PLAIN_RENDERER_LAB.intrinsicSize,
    sizes: new Map(),
    ...overrides,
  }
  const { container } = render(
    <PlainGroupList
      groups={[GROUP]}
      box={box}
      conversationId="conv"
      getResult={(() => undefined) as never}
      settings={{} as never}
      showThinking={false}
      planContext={undefined as never}
      enteringKey={null}
      settlingKey={null}
      clearEntering={() => {}}
      clearSettling={() => {}}
    />,
  )
  return container.querySelectorAll<HTMLElement>('.transcript-plain-group')
}

describe('plain group box', () => {
  it('ships with content-visibility OFF (Safari-first -- see the file header)', () => {
    expect(DEFAULT_PLAIN_RENDERER_LAB.contentVisibility).toBe(false)
  })

  it('applies NO inline sizing style by default -- plain document flow', () => {
    const [box] = boxes()
    expect(box.style.contentVisibility).toBe('')
    expect(box.style.containIntrinsicSize).toBe('')
  })

  it('carries the group key so the height recorder can attribute it', () => {
    const [box] = boxes()
    expect(box.dataset.groupKey).toBeTruthy()
  })

  it('opts in to offscreen skipping with a reserved height when the knob is on', () => {
    const [box] = boxes({ contentVisibility: true })
    expect(box.style.contentVisibility).toBe('auto')
    expect(box.style.containIntrinsicSize).toMatch(/^auto \d+px$/)
  })

  it('uses the measured height for the reserved size when one exists', () => {
    const [box] = boxes({ contentVisibility: true, sizes: new Map([['compacted-2026-07-25T00:00:00.000Z', 777]]) })
    // Bucketed up to the next 16px step.
    expect(box.style.containIntrinsicSize).toBe('auto 784px')
  })

  it('uses the flat height verbatim under the flat sizing knob', () => {
    const [box] = boxes({ contentVisibility: true, sizing: 'flat', intrinsicSize: 320 })
    expect(box.style.containIntrinsicSize).toBe('auto 320px')
  })
})

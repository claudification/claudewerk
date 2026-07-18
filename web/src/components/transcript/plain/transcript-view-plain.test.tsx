/**
 * TranscriptViewPlain -- unit + smoke coverage for the plain renderer's
 * mechanisms: render smoke (incl. the seqless #301 class), the top-sentinel
 * backfill trigger, and the scrollHeight-delta prepend anchor's
 * detached-vs-following decision.
 *
 * jsdom has no layout, so scroll geometry is stubbed per-element; the
 * behaviors under test are the DECISIONS (when to load, when to compensate),
 * not real pixel math -- that part is device-verified via the [follow] /
 * [window] console channels.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'
import { TopSentinel } from './top-sentinel'
import { TranscriptViewPlain } from './transcript-view-plain'
import { usePrependAnchor } from './use-prepend-anchor'

type Engine = Parameters<typeof usePrependAnchor>[0]

function entry(i: number, seq?: number): TranscriptEntry {
  return {
    type: 'user',
    uuid: `u-${i}`,
    timestamp: '2026-07-18T11:00:00.000Z',
    message: { role: 'user', content: `msg ${i}` },
    ...(seq !== undefined && { seq }),
  } as unknown as TranscriptEntry
}

// jsdom lacks both observers the plain renderer relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub

// Controllable IntersectionObserver stub: tests trigger callbacks manually.
const ioInstances: Array<{ cb: IntersectionObserverCallback; observed: Element[]; disconnected: boolean }> = []
class IntersectionObserverStub {
  cb: IntersectionObserverCallback
  observed: Element[] = []
  disconnected = false
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    ioInstances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IntersectionObserverStub

afterEach(cleanup)
beforeEach(() => {
  ioInstances.length = 0
  act(() => {
    useConversationsStore.setState({
      selectedConversationId: null,
      conversationsById: {},
      streamingText: {},
      streamingThinking: {},
      controlPanelPrefs: { showPerfMonitor: false },
    } as never)
  })
})

describe('TranscriptViewPlain -- render smoke', () => {
  it('renders a seq-carrying transcript without throwing', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(i, i + 1))
    expect(() =>
      render(<TranscriptViewPlain conversationId="c1" entries={entries} follow cacheKey="conv_plain" />),
    ).not.toThrow()
  })

  it('does NOT throw React #301 on a fully-seqless transcript with follow on', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(i))
    expect(() =>
      render(<TranscriptViewPlain conversationId="c1" entries={entries} follow cacheKey="conv_seqless" />),
    ).not.toThrow()
  })

  it('renders the top sentinel only when older history exists', () => {
    // oldest seq 1 + no window -> no sentinel
    const complete = Array.from({ length: 10 }, (_, i) => entry(i, i + 1))
    render(<TranscriptViewPlain conversationId="c1" entries={complete} follow cacheKey="conv_a" />)
    expect(ioInstances.filter(io => !io.disconnected)).toHaveLength(0)
    cleanup()
    // oldest seq 50 -> server has more -> sentinel observed
    const partial = Array.from({ length: 10 }, (_, i) => entry(i, i + 50))
    render(<TranscriptViewPlain conversationId="c1" entries={partial} follow cacheKey="conv_b" />)
    expect(ioInstances.filter(io => !io.disconnected)).toHaveLength(1)
  })
})

describe('TopSentinel -- backfill trigger', () => {
  function fire(io: (typeof ioInstances)[0], isIntersecting: boolean) {
    act(() => {
      io.cb([{ isIntersecting } as IntersectionObserverEntry], io as unknown as IntersectionObserver)
    })
  }

  it('calls onNearTop when the sentinel intersects, not when it leaves', () => {
    const onNearTop = vi.fn()
    const scrollRef = { current: document.createElement('div') }
    render(<TopSentinel scrollRef={scrollRef} reobserveKey={1} onNearTop={onNearTop} />)
    const io = ioInstances.at(-1)!
    fire(io, true)
    expect(onNearTop).toHaveBeenCalledTimes(1)
    fire(io, false)
    expect(onNearTop).toHaveBeenCalledTimes(1)
  })

  it('re-creates the observer when reobserveKey changes (forces a fresh initial callback)', () => {
    const scrollRef = { current: document.createElement('div') }
    const { rerender } = render(<TopSentinel scrollRef={scrollRef} reobserveKey={1} onNearTop={() => {}} />)
    const first = ioInstances.at(-1)!
    rerender(<TopSentinel scrollRef={scrollRef} reobserveKey={2} onNearTop={() => {}} />)
    expect(first.disconnected).toBe(true)
    expect(ioInstances.at(-1)).not.toBe(first)
    expect(ioInstances.at(-1)!.disconnected).toBe(false)
  })
})

describe('usePrependAnchor -- scrollHeight-delta compensation', () => {
  function makeEngine(el: HTMLElement, atBottom: boolean) {
    const state = {
      isAtBottom: atBottom,
      isNearBottom: atBottom,
      get scrollTop() {
        return el.scrollTop
      },
      set scrollTop(v: number) {
        el.scrollTop = v
      },
    }
    return { scrollRef: { current: el }, state } as unknown as Engine
  }

  function Harness({ engine, armRef }: { engine: Engine; armRef: { current: (() => void) | null } }) {
    armRef.current = usePrependAnchor(engine)
    // A dummy state-free child; rerendering the harness re-runs the layout effect.
    return <div />
  }

  function setScrollHeight(el: HTMLElement, v: number) {
    Object.defineProperty(el, 'scrollHeight', { value: v, configurable: true })
  }

  it('compensates scrollTop for a detached reader when content grows above', () => {
    const el = document.createElement('div')
    setScrollHeight(el, 1000)
    el.scrollTop = 300
    const engine = makeEngine(el, false)
    const armRef = { current: null as (() => void) | null }
    const { rerender } = render(<Harness engine={engine} armRef={armRef} />)
    act(() => armRef.current!())
    setScrollHeight(el, 1800) // +800px prepended
    rerender(<Harness engine={engine} armRef={armRef} />)
    expect(el.scrollTop).toBe(1100) // 300 + 800
  })

  it('does NOT compensate while at the bottom (the engine pin owns the anchor)', () => {
    const el = document.createElement('div')
    setScrollHeight(el, 1000)
    el.scrollTop = 600
    const engine = makeEngine(el, true)
    const armRef = { current: null as (() => void) | null }
    const { rerender } = render(<Harness engine={engine} armRef={armRef} />)
    act(() => armRef.current!())
    setScrollHeight(el, 1800)
    rerender(<Harness engine={engine} armRef={armRef} />)
    expect(el.scrollTop).toBe(600) // untouched
  })

  it('stays armed across a no-change commit, fires once, then disarms', () => {
    const el = document.createElement('div')
    setScrollHeight(el, 1000)
    el.scrollTop = 300
    const engine = makeEngine(el, false)
    const armRef = { current: null as (() => void) | null }
    const { rerender } = render(<Harness engine={engine} armRef={armRef} />)
    act(() => armRef.current!())
    rerender(<Harness engine={engine} armRef={armRef} />) // no height change -- stays armed
    expect(el.scrollTop).toBe(300)
    setScrollHeight(el, 1400)
    rerender(<Harness engine={engine} armRef={armRef} />)
    expect(el.scrollTop).toBe(700)
    setScrollHeight(el, 1600) // NOT armed anymore -- no further compensation
    rerender(<Harness engine={engine} armRef={armRef} />)
    expect(el.scrollTop).toBe(700)
  })
})

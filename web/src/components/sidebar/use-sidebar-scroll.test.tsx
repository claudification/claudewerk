import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { __resetRowHeightCache } from './row-height-cache'
import { useSidebarScroll } from './use-sidebar-scroll'

const SELECTED = 'conv-selected'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  __resetRowHeightCache()
  document.body.innerHTML = ''
})

beforeEach(() => {
  useConversationsStore.setState({
    selectedConversationId: SELECTED,
    lastSelectReason: 'command-palette',
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
})

/** Records which element each scrollIntoView call landed on. */
function spyOnScroll() {
  const hits: HTMLElement[] = []
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    hits.push(this)
  }
  return hits
}

function Harness({ open, rowId = SELECTED }: { open: boolean; rowId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useSidebarScroll(ref, open)
  return (
    <div ref={ref} data-testid="scroller">
      <div data-conversation-id={rowId} data-testid="sidebar-row" />
    </div>
  )
}

describe('useSidebarScroll', () => {
  it('parks the selected row when the selection changes', () => {
    const hits = spyOnScroll()
    render(<Harness open={false} />)
    expect(hits).toHaveLength(1)
    expect((hits[0] as HTMLElement).dataset.testid).toBe('sidebar-row')
  })

  // THE REGRESSION. Transcript conversation-pills (markdown.tsx) carry the same
  // data-conversation-id and sit EARLIER in document order than the sidebar, so
  // the old document-wide querySelector scrolled the transcript instead of the
  // list -- and the sidebar sat at the top looking broken.
  it('never targets a transcript pill outside the sidebar', () => {
    const pill = document.createElement('button')
    pill.className = 'conversation-pill'
    pill.dataset.conversationId = SELECTED
    pill.dataset.testid = 'transcript-pill'
    document.body.appendChild(pill)

    const hits = spyOnScroll()
    render(<Harness open={false} />)

    expect(hits.length).toBeGreaterThan(0)
    for (const el of hits) expect(el.dataset.testid).toBe('sidebar-row')
  })

  it('scrolls on an explicit locate request', () => {
    const hits = spyOnScroll()
    render(<Harness open />)
    hits.length = 0
    act(() => {
      window.dispatchEvent(new CustomEvent('locate-conversation'))
    })
    expect(hits).toHaveLength(1)
  })

  it('does nothing when the selected conversation has no row in this list', () => {
    const hits = spyOnScroll()
    render(<Harness open={false} rowId="some-other-conversation" />)
    expect(hits).toHaveLength(0)
  })

  it('stops listening for locate after unmount', () => {
    const hits = spyOnScroll()
    const { unmount } = render(<Harness open />)
    unmount()
    hits.length = 0
    act(() => {
      window.dispatchEvent(new CustomEvent('locate-conversation'))
    })
    expect(hits).toHaveLength(0)
  })
})

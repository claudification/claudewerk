import { type RefObject, useCallback, useEffect, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { captureRowHeights } from './row-height-cache'

/**
 * Find the selected row INSIDE the sidebar's own scroll container.
 *
 * Scoped, not `document.querySelector`, for two reasons that both used to bite:
 * transcript conversation-pills carry the same `data-conversation-id`
 * (markdown.tsx) and win on document order, so a document-wide lookup would
 * scroll the transcript instead of the sidebar; and there is now exactly one
 * sidebar instance, so the old "which copy is actually visible" offsetParent
 * dance has nothing left to disambiguate.
 */
function findRow(root: HTMLElement | null, id: string): HTMLElement | null {
  // Escaped for a QUOTED attribute value, where only the quote and the escape
  // character are special -- not CSS.escape, which escapes for an identifier and
  // would mangle the perfectly legal punctuation in an ad-hoc conversation id.
  const value = id.replace(/["\\]/g, '\\$&')
  return root?.querySelector<HTMLElement>(`[data-conversation-id="${value}"]`) ?? null
}

/**
 * Keep the selected conversation parked in the sidebar's scroll position, at all
 * times, whether or not the sidebar is currently showing.
 *
 * The old behaviour was to open the sheet and THEN go looking: a fresh mount at
 * scrollTop 0, a smooth scroll racing a 540ms timer, landing on a target whose
 * offset was computed from placeholder row heights. You watched it hunt and miss.
 *
 * Now the node is never unmounted and never `display:none` -- when hidden it is
 * off-canvas via `transform`, which keeps it fully laid out -- so we can scroll
 * it instantly and invisibly the moment the selection changes. By the time you
 * pull it in from the left it is already sitting on the right conversation.
 */
export function useSidebarScroll(scrollRef: RefObject<HTMLElement | null>, open: boolean) {
  const selectedId = useConversationsStore(s => s.selectedConversationId)

  const park = useCallback(
    (opts: ScrollIntoViewOptions) => {
      const id = useConversationsStore.getState().selectedConversationId
      if (!id) return
      findRow(scrollRef.current, id)?.scrollIntoView({ block: 'center', ...opts })
    },
    [scrollRef],
  )

  const pulse = useCallback(() => {
    const id = useConversationsStore.getState().selectedConversationId
    if (!id) return
    const el = findRow(scrollRef.current, id)
    if (!el) return
    el.classList.remove('conversation-pulse')
    void el.offsetWidth // force reflow so re-adding restarts the animation
    el.classList.add('conversation-pulse')
    setTimeout(() => el.classList.remove('conversation-pulse'), 1500)
  }, [scrollRef])

  // Selection changed. Hidden -> park instantly and silently (nobody is looking,
  // and an animation we cannot see is just a race waiting to be interrupted).
  // Showing -> 'nearest' + smooth, so a row already on screen does not jump.
  // Deliberately keyed on the selection ALONE: re-running this when `open` flips
  // is what made the sidebar re-scroll on every single open.
  const openRef = useRef(open)
  openRef.current = open
  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the selection ALONE, deliberately. `open` is read through openRef so that opening or closing the sidebar does not re-fire a parking scroll -- that re-fire is the bug this rewrite removes.
  useEffect(() => {
    if (!selectedId) return
    if (!openRef.current) {
      park({ behavior: 'auto' })
      return
    }
    park({ behavior: 'smooth', block: 'nearest' })
    if (useConversationsStore.getState().lastSelectReason !== 'click') pulse()
  }, [selectedId])

  // Opening. The rows we parked against may have been `content-visibility`
  // skipped at their reserved height; now they are on screen and rendered for
  // real. Correct once, on the next frame pair -- a correction, not a settle
  // loop -- while the slide-in is still animating, so it is invisible. Then
  // measure the now-real rows so the NEXT park starts from truth.
  const wasOpen = useRef(open)
  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!opening) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        park({ behavior: 'auto' })
        if (scrollRef.current) captureRowHeights(scrollRef.current)
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [open, park, scrollRef])

  // Explicit "take me there": the crosshair button, and anything else that fires
  // the event. Always definitive -- centre, instant, plus a pulse.
  useEffect(() => {
    function onLocate() {
      park({ behavior: 'auto' })
      pulse()
    }
    window.addEventListener('locate-conversation', onLocate)
    return () => window.removeEventListener('locate-conversation', onLocate)
  }, [park, pulse])
}

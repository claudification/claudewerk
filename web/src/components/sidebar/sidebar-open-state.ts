import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsSidebarOverlay } from '@/hooks/use-media-query'
import { isSidebarOverlay } from '@/lib/breakpoints'

/** Persisted DESKTOP preference only. The overlay is transient by design. */
const STORAGE_KEY = 'sidebar-collapsed'

function desktopPreferenceOpen(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'true'
}

export type SidebarState = {
  /** Showing: docked-and-expanded, or overlay-and-slid-in. */
  open: boolean
  /** Overlaying the content (below `lg`) rather than docked beside it. */
  overlay: boolean
  toggle: () => void
  /** Idempotent open -- for gestures, where a toggle would close what you just swiped for. */
  show: () => void
  close: () => void
}

/**
 * One open/closed state for BOTH presentations, because they are the same
 * question -- "is the conversation list showing" -- and the hamburger and the
 * desktop collapse chevron are two buttons onto it.
 *
 * The only thing that differs is the default and whether it sticks: a docked
 * sidebar remembers whether you collapsed it, an overlay always starts closed
 * (it covers the transcript, so a remembered "open" would be an ambush on load).
 */
export function useSidebarOpen(): SidebarState {
  const overlay = useIsSidebarOverlay()
  const [open, setOpen] = useState(() => !isSidebarOverlay() && desktopPreferenceOpen())

  // Crossing the layout breakpoint (rotate a tablet, drag a window wide)
  // re-derives the default for the presentation we just moved into.
  const prevOverlay = useRef(overlay)
  useEffect(() => {
    if (prevOverlay.current === overlay) return
    prevOverlay.current = overlay
    setOpen(overlay ? false : desktopPreferenceOpen())
  }, [overlay])

  const toggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev
      if (!isSidebarOverlay()) localStorage.setItem(STORAGE_KEY, String(!next))
      return next
    })
  }, [])

  const show = useCallback(() => setOpen(true), [])
  const close = useCallback(() => setOpen(false), [])

  return { open, overlay, toggle, show, close }
}

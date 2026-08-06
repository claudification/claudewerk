import { useCallback, useEffect, useRef, useState } from 'react'
import { computeHoverCoords, DEFAULT_PANEL_WIDTH, type HoverCoords } from './hover-card-position'

/**
 * The hover card's state machine: deliberate open delay, grace period on leave
 * so the pointer can travel trigger -> panel, and every dismissal rule in one
 * place. Split from the component so the JSX stays a shell (SPLIT DISCIPLINE)
 * and so the timing can be driven in tests without a portal.
 */

/** Long enough not to fire while scanning a dense list, short enough to feel
 *  responsive. Jonas floated 2s; 600ms reads snappier while still intentional. */
export const HOVER_OPEN_DELAY_MS = 600
const HOVER_CLOSE_DELAY_MS = 120

interface HoverCardState {
  coords: HoverCoords | null
  triggerRef: React.RefObject<HTMLSpanElement | null>
  panelRef: React.RefObject<HTMLDivElement | null>
  open: (immediate?: boolean) => void
  close: (immediate?: boolean) => void
  cancelClose: () => void
}

export function useHoverCard(width = DEFAULT_PANEL_WIDTH, openDelayMs = HOVER_OPEN_DELAY_MS, openOnTap = false) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [coords, setCoords] = useState<HoverCoords | null>(null)

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setCoords(computeHoverCoords(rect, { width: window.innerWidth, height: window.innerHeight }, width))
  }, [width])

  const open = useCallback(
    (immediate = false) => {
      clearTimeout(closeTimer.current)
      clearTimeout(openTimer.current)
      if (immediate) place()
      else openTimer.current = setTimeout(place, openDelayMs)
    },
    [place, openDelayMs],
  )

  const close = useCallback((immediate = false) => {
    clearTimeout(openTimer.current)
    if (immediate) {
      clearTimeout(closeTimer.current)
      setCoords(null)
      return
    }
    closeTimer.current = setTimeout(() => setCoords(null), HOVER_CLOSE_DELAY_MS)
  }, [])

  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), [])

  // Dismiss on scroll / resize / Escape -- the panel is anchored to a viewport
  // rect captured at open time, so any layout shift invalidates it. With
  // openOnTap an outside pointerdown dismisses too (touch has no mouseleave).
  useEffect(() => {
    if (!coords) return
    const dismiss = () => close(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      close(true)
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey)
    if (openOnTap) document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [coords, close, openOnTap])

  // Clear pending timers on unmount (refs are stable -> [] deps).
  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )

  const state: HoverCardState = { coords, triggerRef, panelRef, open, close, cancelClose }
  return state
}

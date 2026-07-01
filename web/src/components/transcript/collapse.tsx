import { type ReactNode, useEffect, useRef, useState } from 'react'

/** In-flight decoration motion. Asymmetric on purpose: the pill/spinner fade out
 *  FAST (opacity) so they visually disappear quickly, while the height collapses
 *  SLOWLY so the freed space closes gently -- no jerk. Reveal is snappy. */
const INFLIGHT_REVEAL_MS = 200 // height expand on enter
const INFLIGHT_COLLAPSE_MS = 500 // height collapse on exit
const INFLIGHT_OPACITY_MS = 200 // fade, both directions

/**
 * Smoothly collapses its children's height (and fades them) when `show` flips
 * false, instead of unmounting them instantly. In-flight transcript decorations
 * (thinking sparkline/pill, verb spinner) live at the very bottom inside the
 * last measured virtual item; unmounting them in one frame drops scrollHeight,
 * the browser clamps scrollTop, and the content snaps up -- the "poof" jerk.
 *
 * With this, removal animates: the grid-template-rows 1fr->0fr trick collapses
 * height over INFLIGHT_COLLAPSE_MS while the content fades, so the item's
 * ResizeObserver reports a GRADUAL shrink -> the browser clamp settles the
 * content gently instead of snapping. Children stay mounted through the exit
 * (the last shown content is frozen during collapse via lastShown), then render
 * nothing once closed. Symmetric on enter (fades/expands in).
 */
export function Collapse({
  show,
  inMs = INFLIGHT_REVEAL_MS,
  outMs = INFLIGHT_COLLAPSE_MS,
  opacityMs = INFLIGHT_OPACITY_MS,
  children,
}: {
  show: boolean
  inMs?: number
  outMs?: number
  opacityMs?: number
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(show)
  const [open, setOpen] = useState(show)
  // Freeze the last non-empty children so the exit animation has something to
  // show even after the parent stops providing content.
  const lastShown = useRef<ReactNode>(children)
  if (show) lastShown.current = children

  useEffect(() => {
    if (show) {
      setMounted(true)
      const id = requestAnimationFrame(() => setOpen(true))
      return () => cancelAnimationFrame(id)
    }
    setOpen(false)
    // Unmount only after the LONGEST exit transition (height collapse) finishes.
    const id = setTimeout(() => setMounted(false), Math.max(outMs, opacityMs))
    return () => clearTimeout(id)
  }, [show, outMs, opacityMs])

  if (!mounted) return null
  // Height animates per-direction (fast in, slow out); opacity is symmetric.
  const heightMs = open ? inMs : outMs
  return (
    <div
      className="grid ease-out motion-reduce:transition-none"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transition: `grid-template-rows ${heightMs}ms ease-out, opacity ${opacityMs}ms ease-out`,
      }}
    >
      <div className="min-h-0 overflow-hidden">{show ? children : lastShown.current}</div>
    </div>
  )
}

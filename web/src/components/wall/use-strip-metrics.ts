/**
 * "Is this segment wide enough for its label" is a question about PIXELS, and
 * the A5 strip is the one wall surface whose text lives inside a box whose width
 * is data. A share threshold guessed at author time gets it wrong on a laptop
 * and wrong again in ambient mode, where `--wall-fs` moves the type up a size.
 * So measure both: the box, and the character advance at whatever size the strip
 * is currently rendering.
 *
 * Degrades to `{ width: 0, charPx: 0 }`, which reads as "nothing fits" -- every
 * segment falls back to its count. That is the safe direction, and it is also
 * what happens under jsdom, where there is no layout and no ResizeObserver.
 */

import { type RefObject, useEffect, useRef, useState } from 'react'

export interface StripMetrics {
  /** Content width of the observed element, px. */
  width: number
  /** One monospace character at the element's current font size, px. */
  charPx: number
}

/** Monospace advance as a fraction of the em. Every mono face in the stack sits
 *  within a hair of this; `now-bar-fold` carries the safety margin. */
const MONO_ADVANCE_EM = 0.6

const NOTHING: StripMetrics = { width: 0, charPx: 0 }

function measure(el: HTMLElement): StripMetrics {
  const width = el.clientWidth
  if (!width) return NOTHING
  const fontSize = Number.parseFloat(getComputedStyle(el).fontSize) || 0
  return { width, charPx: fontSize * MONO_ADVANCE_EM }
}

const same = (a: StripMetrics, b: StripMetrics) => a.width === b.width && a.charPx === b.charPx

export function useStripMetrics<T extends HTMLElement>(): [RefObject<T | null>, StripMetrics] {
  const ref = useRef<T>(null)
  const [metrics, setMetrics] = useState<StripMetrics>(NOTHING)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const next = measure(el)
      setMetrics(prev => (same(prev, next) ? prev : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, metrics]
}

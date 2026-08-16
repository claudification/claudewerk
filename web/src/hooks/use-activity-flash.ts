/**
 * `useActivityFlash` -- "something just arrived", as a boolean.
 *
 * Shared by every dock light: shells blink on terminal output, parked surfaces
 * blink on a run step. Both want the same thing -- a brief bright frame when a
 * signal value advances, and no blink at all for a re-render that carries no
 * news.
 *
 * The comparison happens during RENDER on purpose. Doing it in an effect costs
 * one unlit frame, which on a fast stream reads as a light that misses beats.
 */

import { useEffect, useState } from 'react'

export function useActivityFlash(signal: number | string | undefined, ms = 600): boolean {
  const [flash, setFlash] = useState(false)
  const [prev, setPrev] = useState(signal)

  if (signal !== prev) {
    setPrev(signal)
    // A signal arriving for the first time is still news worth showing.
    setFlash(true)
  }

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), ms)
    return () => clearTimeout(t)
  }, [flash, ms])

  return flash
}

import { useEffect } from 'react'

/**
 * Hold Option to see through every scrim at once.
 *
 * A modal is usually ABOUT something on the page behind it -- you open WerkMaster
 * to act on the run you were just reading. Dimming that context is right by
 * default and wrong for the two seconds you want to check it, and the answer
 * "close the window, look, reopen it" loses the window's state.
 *
 * The 2s hold is what keeps this from stealing Option. Every Option chord in
 * the app resolves in well under 2s, and pressing any other key cancels the
 * pending bypass outright, so Opt+Enter still does exactly what it did.
 *
 * The effect itself is one CSS rule in globals.css keyed off the attribute this
 * hook sets, which is why it covers every managed surface -- present and future
 * -- instead of each modal having to opt in.
 */

export const BYPASS_ATTR = 'data-backdrop-bypass'
export const BYPASS_HOLD_MS = 2000

interface Options {
  /** Injectable for tests; defaults to the real document element. */
  target?: HTMLElement
  holdMs?: number
}

export function useBackdropBypass({ target, holdMs = BYPASS_HOLD_MS }: Options = {}) {
  useEffect(() => {
    const root = target ?? document.documentElement
    let timer: ReturnType<typeof setTimeout> | null = null

    const cancelPending = () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    }

    const release = () => {
      cancelPending()
      root.removeAttribute(BYPASS_ATTR)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      /* Any non-Alt key means this is a chord, not a hold. Bail and stay bailed
         until Option is released and pressed again. */
      if (e.key !== 'Alt') {
        cancelPending()
        return
      }
      // Auto-repeat fires continuously while held; only the first one arms.
      if (e.repeat || timer !== null || root.hasAttribute(BYPASS_ATTR)) return
      timer = setTimeout(() => {
        timer = null
        root.setAttribute(BYPASS_ATTR, 'on')
      }, holdMs)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') release()
    }

    /* Option-Tab away and the keyup never arrives, so the app would be left
       permanently see-through. Any loss of focus drops it. */
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibility)
      release()
    }
  }, [target, holdMs])
}

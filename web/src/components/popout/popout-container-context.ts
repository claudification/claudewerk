/**
 * PopoutContainerContext -- the `document.body` that Radix portals (Dialog,
 * Select, ...) should target when the subtree is rendered inside a detached
 * PopoutWindow. Radix `Portal` defaults to the MAIN window's `document.body`,
 * so a nested dialog opened from a detached modal escapes back to the opener
 * window. PopoutWindow provides its own body here; the shared ui/ portal
 * wrappers read it and pass it as `container`. null = main window (Radix default).
 */

import { createContext, useContext } from 'react'

export const PopoutContainerContext = createContext<HTMLElement | null>(null)

/** The portal container for the current subtree, or null when in the main window. */
export function usePopoutContainer(): HTMLElement | null {
  return useContext(PopoutContainerContext)
}

/**
 * BIND A KEY ON THE WALL'S OWN DOCUMENT -- the plumbing `/` and `T` both need,
 * written once.
 *
 * Three things are easy to get wrong here and all three are invisible when they
 * are wrong:
 *
 *  - WHICH DOCUMENT. Detaching MOVES the surface's canvas by `appendChild` into
 *    a second window, from a subtree the components below it do not re-render
 *    with -- so `ref.current.ownerDocument` is still the OPENER's as far as they
 *    are concerned. The popout container is the only honest answer, and a
 *    handler bound on the wrong document simply never fires.
 *  - WHEN. Parked in the dock, the wall is offscreen: a hotkey that still pulls
 *    focus drags the caret into a surface the user cannot see.
 *  - WHICH PHASE. Capture, because Escape has to be taken before Radix's
 *    dismissable layer sees it, and because the co-listeners on this same node
 *    need a defined order.
 *
 * The callback is read through a ref, so an inline arrow at the call site does
 * not re-bind the listener on every render.
 */

import { type RefObject, useEffect, useRef } from 'react'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { usePopoutContainer } from '../popout/popout-container-context'
import { WALL_MODAL } from './wall-state'

export function useWallHotkey(anchor: RefObject<HTMLElement | null>, onKeyDown: (event: KeyboardEvent) => void): void {
  const popout = usePopoutContainer()
  const presentation = useModalManagerStore(s => s.records[WALL_MODAL.id]?.presentation)

  const handler = useRef(onKeyDown)
  handler.current = onKeyDown

  useEffect(() => {
    if (presentation !== 'inline' && presentation !== 'detached') return
    const el = anchor.current
    if (!el) return
    const doc = popout?.ownerDocument ?? el.ownerDocument

    const listen = (event: KeyboardEvent) => handler.current(event)
    doc.addEventListener('keydown', listen, true)
    return () => doc.removeEventListener('keydown', listen, true)
  }, [presentation, popout, anchor])
}

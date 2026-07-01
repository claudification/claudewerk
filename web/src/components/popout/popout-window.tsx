/**
 * PopoutWindow -- host a React subtree in a REAL second OS window without a new
 * document load. The window is opened BLANK (window.open('')) in the click that
 * triggered it (gesture-safe, done by use-popout-store) and handed here already
 * open; we adopt the opener's styles + theme and createPortal the children into
 * its body. The subtree therefore lives in the PARENT React tree + JS heap: same
 * store, same WebSocket, no second bundle parse, no second auth.
 *
 * Hosted components reach THEIR popup's window/document via usePopoutWindow() --
 * the global window/document fallback means the same component also works inline.
 */

import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { adoptStyles } from './stylesheet-adopt'

interface PopoutTarget {
  win: Window
  doc: Document
}

const PopoutWindowContext = createContext<PopoutTarget | null>(null)

/** The hosting popup's window/document, or the main tab's when rendered inline. */
export function usePopoutWindow(): PopoutTarget {
  return useContext(PopoutWindowContext) ?? { win: window, doc: document }
}

interface PopoutWindowProps {
  /** The already-open blank popup (opened in the triggering gesture). */
  win: Window
  title?: string
  /** Fires when the user closes the popup; the owner should drop the record. */
  onClose: () => void
  children: ReactNode
}

export function PopoutWindow({ win, title, onClose, children }: PopoutWindowProps) {
  const [ready, setReady] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Inline render-time adjustment: when the window reference changes, immediately
  // mark not-ready so we don't portal into a stale document for one frame.
  const [prevWin, setPrevWin] = useState(win)
  if (win !== prevWin) {
    setPrevWin(win)
    setReady(false)
  }

  useEffect(() => {
    const doc = win.document
    doc.body.style.margin = '0'
    doc.body.style.height = '100vh'
    doc.body.style.background = 'var(--background)'
    const cleanupStyles = adoptStyles(doc)
    setReady(true)

    // The popup can be closed by its own window chrome -- detect and notify so the
    // owner drops the record. The window itself is closed by the store action.
    const poll = window.setInterval(() => {
      if (win.closed) onCloseRef.current()
    }, 400)

    return () => {
      window.clearInterval(poll)
      cleanupStyles()
    }
  }, [win])

  useEffect(() => {
    if (ready && title) win.document.title = title
  }, [ready, title, win])

  if (!ready) return null
  return (
    <PopoutWindowContext.Provider value={{ win, doc: win.document }}>
      {createPortal(children, win.document.body)}
    </PopoutWindowContext.Provider>
  )
}

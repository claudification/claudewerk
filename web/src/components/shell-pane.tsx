/**
 * ShellPane -- one host shell rendered into an XtermPane.
 *
 * Subscribe-on-mount, unsubscribe-on-unmount. The broker replays the ring
 * buffer (clear + repaint) on the first subscribe, then streams live
 * `shell_data`. Keystrokes go out as `shell_input`, viewport changes as
 * `shell_resize` (the broker reduces to the min across all viewers).
 *
 * Reused verbatim by the dock-expanded overlay and the detach popout -- the
 * subscription mechanics are identical; only the surrounding chrome differs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type ShellDataMessage, setShellDataHandler, useShellsStore } from '@/hooks/use-shells'
import { inputShell, resizeShell, subscribeShell, unsubscribeShell } from '@/lib/shell-commands'
import { loadTerminalSettings } from './terminal-settings-storage'
import { XtermPane, type XtermPaneHandle } from './xterm-pane'

interface ShellPaneProps {
  shellId: string
  className?: string
}

export function ShellPane({ shellId, className }: ShellPaneProps) {
  const paneRef = useRef<XtermPaneHandle | null>(null)
  const subscribedRef = useRef(false)
  const isConnected = useConversationsStore(s => s.isConnected)
  // Settings loaded once on mount -- the shell shares the terminal's theme/font.
  const [settings] = useState(loadTerminalSettings)

  // Register the inbound byte handler for THIS shell. Replay clears+repaints;
  // data streams. Registered before the first subscribe so no bytes are missed.
  useEffect(() => {
    // The registry keys handlers by shellId, so this only ever sees its own
    // shell's messages -- no shellId re-check needed.
    const handler = (msg: ShellDataMessage) => {
      const pane = paneRef.current
      if (!pane) return
      // Replay = clear + repaint; data = append. Both write the payload.
      if (msg.type === 'shell_replay') pane.clear()
      if (msg.data) pane.write(msg.data)
    }
    setShellDataHandler(shellId, handler)
    useShellsStore.getState().markSubscribed(shellId)
    return () => {
      setShellDataHandler(shellId, null)
      unsubscribeShell(shellId)
      useShellsStore.getState().markUnsubscribed(shellId)
      subscribedRef.current = false
    }
  }, [shellId])

  // Re-subscribe on WS reconnect (broker forgot our viewer; replay repaints).
  useEffect(() => {
    if (!isConnected || !paneRef.current || !subscribedRef.current) return
    const { cols, rows } = paneRef.current.getSize()
    subscribeShell(shellId, cols, rows)
  }, [isConnected, shellId])

  const handleData = useCallback((data: string) => inputShell(shellId, data), [shellId])

  // First fit establishes the subscription; subsequent fits are resizes.
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!subscribedRef.current) {
        subscribedRef.current = true
        subscribeShell(shellId, cols, rows)
      } else {
        resizeShell(shellId, cols, rows)
      }
    },
    [shellId],
  )

  return (
    <XtermPane ref={paneRef} onData={handleData} onResize={handleResize} settings={settings} className={className} />
  )
}

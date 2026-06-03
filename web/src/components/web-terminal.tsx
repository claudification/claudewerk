import { projectIdentityKey } from '@shared/project-uri'
import { Settings, WifiOff, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type TerminalMessage, useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { lastPathSegments } from '@/lib/utils'
import { TerminalSettingsPanel } from './terminal-settings'
import {
  getTheme,
  loadTerminalSettings,
  saveTerminalSettings,
  type TerminalSettings,
} from './terminal-settings-storage'
import { TerminalToolbar } from './terminal-toolbar'
import { XtermPane, type XtermPaneHandle } from './xterm-pane'

interface WebTerminalProps {
  conversationId: string
  onClose: () => void
  popout?: boolean
}

/** Scan inbound PTY bytes for characters that signal an upstream encoding
 *  break (replacement char, lone surrogates, stray zero-width). Logging only;
 *  the data is still written verbatim. */
function scanTerminalData(d: string) {
  for (let i = 0; i < d.length; i++) {
    const code = d.charCodeAt(i)
    if (code === 0xfffd) {
      const hex = [...d.substring(Math.max(0, i - 3), i + 3)]
        .map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(' ')
      console.warn(`[term] REPLACEMENT CHAR at ${i}/${d.length}, nearby: ${hex}`)
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      const isHigh = code <= 0xdbff
      const next = d.charCodeAt(i + 1)
      if (isHigh && !(next >= 0xdc00 && next <= 0xdfff)) {
        console.warn(`[term] LONE SURROGATE U+${code.toString(16)} at ${i}/${d.length}`)
      } else if (!isHigh) {
        console.warn(`[term] ORPHAN LOW SURROGATE U+${code.toString(16)} at ${i}/${d.length}`)
      }
    }
    if (code === 0xfeff || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060) {
      console.warn(`[term] ZERO-WIDTH U+${code.toString(16)} at ${i}/${d.length}`)
    }
  }
}

export function WebTerminal({ conversationId, onClose, popout }: WebTerminalProps) {
  const paneRef = useRef<XtermPaneHandle | null>(null)
  const conversations = useConversationsStore(state => state.conversations)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)
  const setTerminalHandler = useConversationsStore(state => state.setTerminalHandler)
  const isConnected = useConversationsStore(state => state.isConnected)
  const showSwitcher = useConversationsStore(state => state.showSwitcher)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)

  const sendData = useCallback(
    (data: string) => {
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    },
    [sendWsMessage, conversationId],
  )

  const handleData = useCallback(
    (data: string) => {
      if (data.length > 1) {
        console.log('[terminal] onData (multi-char, likely paste):', {
          length: data.length,
          preview: data.slice(0, 80),
        })
      }
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    },
    [sendWsMessage, conversationId],
  )

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    },
    [sendWsMessage, conversationId],
  )

  // App-specific key interception (global shortcuts handled by app.tsx, plus
  // swallowing all keys while the command palette is open).
  const customKeyHandler = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'k') return false
    if (e.ctrlKey && e.key === ',') return false
    if (e.ctrlKey && e.shiftKey && e.key === 'T') return false
    if (e.ctrlKey && e.shiftKey && e.key === 'Q') return false
    if (useConversationsStore.getState().showSwitcher) return false
    return true
  }, [])

  function handleSettingsChange(newSettings: TerminalSettings) {
    setSettings(newSettings)
    saveTerminalSettings(newSettings)
    // XtermPane re-applies + re-emits onResize (-> terminal_resize) on the new
    // settings object identity, so no manual resize send needed here.
  }

  // Resolve the owning conversation for this agent host (for display purposes)
  const ownerConversation = conversations.find(s => s.connectionIds?.includes(conversationId))

  // Set window title in popout mode
  const projectSettings = useConversationsStore(state => state.projectSettings)
  useEffect(() => {
    if (!popout) return
    if (ownerConversation) {
      const ps = projectSettings[projectIdentityKey(ownerConversation.project)]
      const name = ps?.label || extractProjectLabel(ownerConversation.project) || conversationId.slice(0, 8)
      document.title = `TTY: ${name}`
    } else {
      document.title = `TTY: ${conversationId.slice(0, 8)}`
    }
  }, [popout, conversationId, ownerConversation, projectSettings])

  // Wire the inbound PTY-byte handler to the pane.
  useEffect(() => {
    const handler = (msg: TerminalMessage) => {
      if (msg.conversationId !== conversationId) return
      if (msg.type === 'terminal_data' && msg.data) {
        scanTerminalData(msg.data)
        paneRef.current?.write(msg.data)
      } else if (msg.type === 'terminal_error') {
        setTerminalError(msg.error || 'Connection lost')
      }
    }
    setTerminalHandler(handler)
    return () => {
      setTerminalHandler(null)
      sendWsMessage({ type: 'terminal_detach', conversationId })
    }
  }, [conversationId, sendWsMessage, setTerminalHandler])

  // Re-attach when WS reconnects
  useEffect(() => {
    if (!isConnected || !paneRef.current) return
    setTerminalError(null)
    const { cols, rows } = paneRef.current.getSize()
    sendWsMessage({ type: 'terminal_attach', conversationId, cols, rows })
  }, [isConnected, conversationId, sendWsMessage])

  // Terminal-local shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
        e.preventDefault()
        onClose()
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        onClose()
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Prevent scroll events from leaking to parent page
  // position:fixed removes the body from scroll flow entirely (overflow:hidden alone fails on iOS Safari)
  useEffect(() => {
    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.overflow = 'hidden'
    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }
  }, [])

  // Catch wheel events that xterm doesn't consume (at scroll bounds)
  // xterm calls stopPropagation when it scrolls, so only leaked events bubble here
  useEffect(() => {
    const el = document.querySelector('[data-terminal-overlay]') as HTMLElement | null
    if (!el) return
    function block(e: WheelEvent) {
      e.preventDefault()
    }
    function blockTouch(e: TouchEvent) {
      e.preventDefault()
    }
    // must be passive:false -- handler calls preventDefault to block parent scroll
    // react-doctor-disable-next-line react-doctor/client-passive-event-listeners
    el.addEventListener('wheel', block, { passive: false })
    // react-doctor-disable-next-line react-doctor/client-passive-event-listeners
    el.addEventListener('touchmove', blockTouch, { passive: false })
    return () => {
      el.removeEventListener('wheel', block)
      el.removeEventListener('touchmove', blockTouch)
    }
  }, [])

  // Re-focus terminal when switcher/settings close
  useEffect(() => {
    if (!showSwitcher && !showSettings) {
      paneRef.current?.focus()
    }
  }, [showSwitcher, showSettings])

  const showDisconnected = !isConnected || !!terminalError
  const currentTheme = getTheme(settings.themeId)

  return (
    <div
      data-terminal-overlay
      role="application"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{ background: currentTheme.background, overscrollBehavior: 'none' }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, input, select, textarea')) return
        paneRef.current?.focus()
      }}
      onKeyDown={() => paneRef.current?.focus()}
    >
      {/* Minimal header */}
      <div
        className="shrink-0 flex items-center border-b"
        style={{ background: currentTheme.black, borderColor: currentTheme.brightBlack }}
      >
        <span className="px-3 py-1.5 text-[10px] font-mono flex-1" style={{ color: currentTheme.brightBlack }}>
          {showDisconnected && <WifiOff className="size-3 inline mr-1.5" />}
          {ownerConversation
            ? lastPathSegments(projectPath(ownerConversation.project), 2)
            : `TERMINAL - ${conversationId.slice(0, 8)}`}
        </span>
        <div className="flex items-center gap-1 px-2 shrink-0">
          <span className="text-[10px] font-mono mr-1 hidden sm:inline" style={{ color: currentTheme.brightBlack }}>
            ^, settings ^⇧Q close
          </span>
          <button
            type="button"
            onClick={() => setShowSettings(prev => !prev)}
            className="p-1 transition-colors"
            style={{ color: showSettings ? currentTheme.blue : currentTheme.brightBlack }}
            title="Settings (Ctrl+,)"
          >
            <Settings className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 transition-colors"
            style={{ color: currentTheme.brightBlack }}
            title="Close terminal (Ctrl+Shift+Q)"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Disconnected / error banner */}
      {showDisconnected && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
          style={{ background: `${currentTheme.red}15`, borderColor: `${currentTheme.red}40` }}
        >
          <WifiOff className="size-3.5" style={{ color: currentTheme.red }} />
          <span className="text-xs font-mono" style={{ color: currentTheme.red }}>
            {terminalError || 'Disconnected - waiting for reconnect...'}
          </span>
        </div>
      )}

      {/* Shortcut toolbar - above terminal to avoid iOS task switcher conflict at bottom */}
      <TerminalToolbar onSend={sendData} />

      {/* Terminal area */}
      <div className="relative flex-1 min-h-0 overflow-hidden" style={{ overscrollBehavior: 'contain' }}>
        <XtermPane
          ref={paneRef}
          onData={handleData}
          onResize={handleResize}
          settings={settings}
          customKeyHandler={customKeyHandler}
          className="absolute inset-0 p-1"
        />

        {showSettings && (
          <TerminalSettingsPanel
            settings={settings}
            onChange={handleSettingsChange}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </div>
  )
}

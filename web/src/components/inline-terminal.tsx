/**
 * Inline Terminal - xterm.js rendered in the content area (not fullscreen overlay)
 * Used when defaultView is 'tty' - shows terminal where transcript would be.
 */

import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { WifiOff } from 'lucide-react'
import { type TerminalMessage, useConversationsStore } from '@/hooks/use-conversations'
import { normalizeTruecolorSgr } from '@/lib/normalize-truecolor-sgr'
import { getFont, getTheme, loadTerminalSettings } from './terminal-settings-storage'
import { TerminalToolbar } from './terminal-toolbar'

interface InlineTerminalProps {
  conversationId: string
}

export function InlineTerminal({ conversationId }: InlineTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // fallow-ignore-next-line code-duplication
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)
  const setTerminalHandler = useConversationsStore(state => state.setTerminalHandler)
  const isConnected = useConversationsStore(state => state.isConnected)
  const showSwitcher = useConversationsStore(state => state.showSwitcher)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  // react-doctor-disable-next-line react-doctor/no-derived-state -- lazy one-shot init, not synced from other state
  const [themeColors] = useState(() => getTheme(loadTerminalSettings().themeId))

  useEffect(() => {
    if (!terminalRef.current) return

    const settings = loadTerminalSettings()
    const theme = getTheme(settings.themeId)
    const font = getFont(settings.fontId)

    const terminal = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: settings.fontSize,
      // 1.0, not 1.2 -- see xterm-pane.tsx: a >1 lineHeight cuts a horizontal
      // gap through block / box-drawing glyphs and breaks every TUI's borders.
      lineHeight: 1.0,
      cursorBlink: false,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Let global shortcuts pass through
      if (e.ctrlKey && e.key === 'k') return false
      if (e.ctrlKey && e.shiftKey && (e.key === 'Q' || e.key === 'T')) return false
      // Block ALL event types to prevent xterm from also processing Enter
      if (e.shiftKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          sendWsMessage({ type: 'terminal_data', conversationId, data: '\n' })
        }
        return false
      }
      if (useConversationsStore.getState().showSwitcher) return false
      return true
    })

    terminal.open(terminalRef.current)

    // Opt-in WebGL: the default DOM renderer renders truecolor accurately on
    // every GPU, while the WebGL addon mis-packs color channels on some drivers.
    if (settings.rendererId === 'webgl') {
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => webglAddon.dispose())
        terminal.loadAddon(webglAddon)
      } catch {}
    }

    fitAddon.fit()
    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    // Clean slate before PTY data flows in
    terminal.write('\x1bc\x1b[2J\x1b[H\x1b[?25l')

    const dataDisposable = terminal.onData(data => {
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    })

    const handler = (msg: TerminalMessage) => {
      if (msg.conversationId !== conversationId) return
      if (msg.type === 'terminal_data' && msg.data) {
        terminal.write(normalizeTruecolorSgr(msg.data))
      } else if (msg.type === 'terminal_error') {
        setTerminalError(msg.error || 'Connection lost')
      }
    }
    setTerminalHandler(handler)

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const { cols, rows } = terminal
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    })
    resizeObserver.observe(terminalRef.current)

    terminal.focus()

    // Bundled web fonts load async (font-display: swap), so xterm measures the
    // glyph cell + per-glyph WidthCache against the FALLBACK font at open(). Once
    // the real font swaps in those metrics are stale and punctuation drifts
    // off-grid. fitAddon.fit() does NOT re-measure -- it only re-divides the
    // container by the cached cell. Force a real re-measure via a font OPTION
    // change; the OptionsService setter diffs values, so bounce through a
    // sentinel to set the SAME family.
    const remeasureFont = () => {
      if (xtermRef.current !== terminal) return
      if (terminal.options.fontFamily === font.family) {
        terminal.options.fontFamily = 'monospace'
        terminal.options.fontFamily = font.family
      }
      fitAddon.fit()
      const { cols, rows } = terminal
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    }
    const primaryFamily = font.family.split(',')[0]?.trim()
    if (primaryFamily) {
      document.fonts
        ?.load(`${settings.fontSize}px ${primaryFamily}`)
        .then(remeasureFont)
        .catch(() => {})
    }
    document.fonts?.ready.then(remeasureFont)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      setTerminalHandler(null)
      sendWsMessage({ type: 'terminal_detach', conversationId })
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [conversationId, sendWsMessage, setTerminalHandler])

  // react-doctor-disable-next-line react-doctor/no-derived-state -- multi-source: terminalError set by terminal handler AND cleared on reconnect
  // fallow-ignore-next-line code-duplication
  const [prevIsConnected, setPrevIsConnected] = useState(isConnected)
  if (isConnected !== prevIsConnected) {
    setPrevIsConnected(isConnected)
    if (isConnected) setTerminalError(null)
  }

  // Re-attach on WS reconnect
  useEffect(() => {
    if (!isConnected || !xtermRef.current) return
    const { cols, rows } = xtermRef.current
    sendWsMessage({ type: 'terminal_attach', conversationId, cols, rows })
  }, [isConnected, conversationId, sendWsMessage])

  // Re-focus when switcher closes
  useEffect(() => {
    if (!showSwitcher) xtermRef.current?.focus()
  }, [showSwitcher])

  const showDisconnected = !isConnected || !!terminalError

  return (
    <div
      role="application"
      className="flex flex-col h-full"
      style={{ background: themeColors.background }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, input, select, textarea')) return
        xtermRef.current?.focus()
      }}
      onKeyDown={() => xtermRef.current?.focus()}
    >
      {showDisconnected && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
          style={{ background: `${themeColors.red}15`, borderColor: `${themeColors.red}40` }}
        >
          <WifiOff className="size-3.5" style={{ color: themeColors.red }} />
          <span className="text-xs font-mono" style={{ color: themeColors.red }}>
            {terminalError || 'Disconnected - waiting for reconnect...'}
          </span>
        </div>
      )}
      <TerminalToolbar onSend={data => sendWsMessage({ type: 'terminal_data', conversationId, data })} />
      <div ref={terminalRef} className="flex-1 min-h-0 p-1 overflow-hidden" />
    </div>
  )
}

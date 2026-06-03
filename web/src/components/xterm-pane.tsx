/**
 * XtermPane -- the reusable terminal surface.
 *
 * One xterm.js instance + FitAddon + WebGL, settings application, paste
 * interception, and a ResizeObserver-driven fit. Transport-agnostic: it knows
 * nothing about `terminal_*` vs `shell_*` wire messages. The parent wires bytes
 * via the imperative handle (`write`/`clear`/`focus`/`fit`/`getSize`) and feeds
 * keystrokes / resizes back out through `onData` / `onResize`.
 *
 * Used by `web-terminal.tsx` (claude PTY over `terminal_*`) and
 * `shell-pane.tsx` (host shell over `shell_*`).
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import { getFont, getTheme, type TerminalSettings } from './terminal-settings-storage'

export interface XtermPaneHandle {
  /** Write PTY bytes to the screen. */
  write: (data: string) => void
  /** Full reset + clear + cursor home + hide cursor (repaint priming). */
  clear: () => void
  focus: () => void
  fit: () => void
  getSize: () => { cols: number; rows: number }
}

interface XtermPaneProps {
  /** User keystrokes (xterm onData). */
  onData: (data: string) => void
  /** Viewport size after a fit (mount, settings change, container resize). */
  onResize: (cols: number, rows: number) => void
  /** Active theme/font/size. Re-applied whenever the object identity changes. */
  settings: TerminalSettings
  /** App-specific key interception, run BEFORE xterm processes the event.
   *  Return false to stop xterm from handling it (same contract as
   *  attachCustomKeyEventHandler). Generic terminal keys (Shift+Enter newline,
   *  Cmd/Ctrl+V paste) are handled internally and take precedence. */
  customKeyHandler?: (e: KeyboardEvent) => boolean
  className?: string
}

export const XtermPane = forwardRef<XtermPaneHandle, XtermPaneProps>(function XtermPane(
  { onData, onResize, settings, customKeyHandler, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // Keep the latest callbacks in refs so the heavy setup effect runs ONCE
  // (mount) and never tears down xterm just because a parent re-rendered.
  const onDataRef = useRef(onData)
  const onResizeRef = useRef(onResize)
  const customKeyRef = useRef(customKeyHandler)
  onDataRef.current = onData
  onResizeRef.current = onResize
  customKeyRef.current = customKeyHandler

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => xtermRef.current?.write(data),
      // RIS (reset) + clear + cursor home + hide cursor -- a clean slate before
      // a (re)paint. Claude Code / shells render their own cursor.
      clear: () => xtermRef.current?.write('\x1bc\x1b[2J\x1b[H\x1b[?25l'),
      focus: () => xtermRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
      getSize: () => ({ cols: xtermRef.current?.cols ?? 80, rows: xtermRef.current?.rows ?? 24 }),
    }),
    [],
  )

  // Main terminal setup -- mount only.
  useEffect(() => {
    if (!containerRef.current) return

    const theme = getTheme(settings.themeId)
    const font = getFont(settings.fontId)
    const terminal = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // App-specific interception first (e.g. global switcher swallowing keys).
      const parentVerdict = customKeyRef.current?.(e)
      if (parentVerdict === false) return false
      // Shift+Enter -> ESC + CR so Claude Code treats it as a newline. Block all
      // event phases so xterm doesn't ALSO process the bare Enter.
      if (e.shiftKey && e.key === 'Enter') {
        if (e.type === 'keydown') onDataRef.current('\x1b\r')
        return false
      }
      return true
    })

    terminal.open(containerRef.current)

    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => webglAddon.dispose())
      terminal.loadAddon(webglAddon)
    } catch {
      // WebGL not available
    }

    fitAddon.fit()
    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    // Prime with a clean state before PTY data flows in.
    terminal.write('\x1bc\x1b[2J\x1b[H\x1b[?25l')

    const dataDisposable = terminal.onData(d => onDataRef.current(d))

    // Cmd/Ctrl+V: preventDefault the native paste (it would double-paste via
    // xterm's own onData) and route the clipboard text through terminal.paste.
    function handleKeyPaste(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && e.type === 'keydown') {
        e.preventDefault()
        navigator.clipboard
          .readText()
          .then(text => {
            if (text) terminal.paste(text)
          })
          .catch(() => {})
      }
    }
    const el = containerRef.current
    el.addEventListener('keydown', handleKeyPaste)

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      onResizeRef.current(terminal.cols, terminal.rows)
    })
    resizeObserver.observe(el)

    terminal.focus()

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      el?.removeEventListener('keydown', handleKeyPaste)
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only setup; settings applied via the effect below
  }, [])

  // Re-apply theme/font/size when settings change (does NOT rebuild xterm).
  useEffect(() => {
    const terminal = xtermRef.current
    if (!terminal) return
    terminal.options.theme = getTheme(settings.themeId)
    terminal.options.fontFamily = getFont(settings.fontId).family
    terminal.options.fontSize = settings.fontSize
    fitAddonRef.current?.fit()
    onResizeRef.current(terminal.cols, terminal.rows)
  }, [settings])

  return <div ref={containerRef} className={cn('overflow-hidden', className)} />
})

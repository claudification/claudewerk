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
  /** Blink the cursor AND keep it visible (don't hide-cursor prime). Default
   *  false so the claude PTY (web-terminal) stays byte-identical -- it renders
   *  its own cursor and primes hidden. Host shells set this so a raw zsh prompt
   *  shows a blinking block immediately, before the shell first repaints. */
  cursorBlink?: boolean
  className?: string
}

export const XtermPane = forwardRef<XtermPaneHandle, XtermPaneProps>(function XtermPane(
  { onData, onResize, settings, customKeyHandler, cursorBlink = false, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  // Keep the latest callbacks in refs so the heavy setup effect runs ONCE
  // (mount) and never tears down xterm just because a parent re-rendered.
  const onDataRef = useRef(onData)
  const onResizeRef = useRef(onResize)
  const customKeyRef = useRef(customKeyHandler)
  onDataRef.current = onData
  onResizeRef.current = onResize
  customKeyRef.current = customKeyHandler

  // RIS (reset) + clear + cursor home, optionally + hide cursor. The claude PTY
  // renders its own cursor so it primes hidden (`?25l`); host shells want the
  // cursor visible immediately, so cursorBlink omits the hide. Stored in a ref
  // so the mount-only handle/effect read the current value without a rebuild.
  const primeRef = useRef('')
  primeRef.current = cursorBlink ? '\x1bc\x1b[2J\x1b[H' : '\x1bc\x1b[2J\x1b[H\x1b[?25l'

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => xtermRef.current?.write(data),
      // RIS (reset) + clear + cursor home (+ hide cursor unless cursorBlink) --
      // a clean slate before a (re)paint.
      clear: () => xtermRef.current?.write(primeRef.current),
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
      cursorBlink,
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

    // WebGL is loaded by the renderer effect below (it syncs the addon to the
    // current rendererId on mount and whenever the setting changes). Default is
    // the DOM renderer -- it renders truecolor accurately on every GPU, whereas
    // the WebGL addon mis-packs color channels on some drivers.

    fitAddon.fit()
    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    // Prime with a clean state before PTY data flows in.
    terminal.write(primeRef.current)

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

    // Bundled web fonts load async (font-display: swap), so xterm measures the
    // glyph cell + per-glyph WidthCache against the FALLBACK font at open(). When
    // the real font swaps in, those metrics are stale and punctuation drifts
    // off-grid (e.g. a gap after every '.', while ':' happens to line up).
    //
    // fitAddon.fit() does NOT fix this -- it only re-divides the container by the
    // already-cached cell size; it never re-measures the glyph. The only thing
    // that re-measures is a font OPTION change (CharSizeService.measure() ->
    // handleCharSizeChanged() -> WidthCache.clear()). The OptionsService setter
    // diffs values, so re-setting the SAME family is a no-op -- bounce through a
    // sentinel to force the re-measure.
    const remeasureFont = () => {
      if (xtermRef.current !== terminal) return
      const fam = getFont(settings.fontId).family
      if (terminal.options.fontFamily === fam) {
        terminal.options.fontFamily = 'monospace'
        terminal.options.fontFamily = fam
      }
      fitAddon.fit()
      onResizeRef.current(terminal.cols, terminal.rows)
    }
    // Explicitly load the primary family to close the race where fonts.ready
    // resolves before xterm's first use has kicked off the download; fonts.ready
    // stays as a catch-all for any remaining face (e.g. Nerd Font icons).
    const primaryFamily = getFont(settings.fontId).family.split(',')[0]?.trim()
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
      el?.removeEventListener('keydown', handleKeyPaste)
      // Explicitly drop the WebGL context/texture-atlas before tearing down the
      // terminal. terminal.dispose() does cascade addon disposal, but browsers
      // cap live WebGL contexts (~16) and an orphaned context holds GPU-backed
      // RSS until GC -- dispose it deterministically so churning panes can't
      // exhaust the context pool.
      webglAddonRef.current?.dispose()
      webglAddonRef.current = null
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

  // Sync the WebGL addon to the renderer setting (load/dispose live, no rebuild).
  // Runs on mount and whenever rendererId changes. DOM renderer = no addon.
  useEffect(() => {
    const terminal = xtermRef.current
    if (!terminal) return
    const wantWebgl = settings.rendererId === 'webgl'
    const haveWebgl = !!webglAddonRef.current
    if (wantWebgl && !haveWebgl) {
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => webglAddon.dispose())
        terminal.loadAddon(webglAddon)
        webglAddonRef.current = webglAddon
      } catch {
        // WebGL not available -- stay on the DOM renderer.
      }
    } else if (!wantWebgl && haveWebgl) {
      webglAddonRef.current?.dispose()
      webglAddonRef.current = null
    }
    // Re-fit so a renderer swap repaints at the correct size.
    fitAddonRef.current?.fit()
  }, [settings.rendererId])

  return <div ref={containerRef} className={cn('overflow-hidden', className)} />
})

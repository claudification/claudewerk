/**
 * Draw block chrome: header (label + size meter + save + fullscreen toggle) wrapping
 * the lazily-loaded Excalidraw canvas. Excalidraw lives in excalidraw-canvas.tsx and
 * is React.lazy'd here so its chunk loads only when a Draw block paints (LAZY LOAD
 * covenant).
 *
 * Size meter: a drawing over DRAW_INLINE_MAX is flagged ("large -- saved as file"),
 * because on submit draw-spill.ts uploads it to a blob and sends a URL reference
 * instead of inline JSON. The drawing is never lost, just parked in a shareable file.
 *
 * Fullscreen goes TRUE-viewport via `position:fixed` on this same container (see
 * use-fullscreen-escape) -- NOT a portal -- so the canvas never remounts and the
 * toggle is instant with the pan/zoom preserved.
 */

import { DRAW_INLINE_MAX, type DrawValue, isDrawValue } from '@shared/draw'
import { Download, Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { DialogFormState } from './dialog-renderer'
import { downloadScene } from './draw-export'
import { useDrawInitial } from './use-draw-initial'
import { useFullscreenEscape } from './use-fullscreen-escape'

const DrawCanvas = lazy(() => import('./excalidraw-canvas'))

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}

export interface DrawBlockProps {
  id: string
  content?: string
  contentUrl?: string
  readOnly?: boolean
  height?: number
  label?: string
  form: DialogFormState
}

export function DrawBlock({ id, content, contentUrl, readOnly, height = 420, label, form }: DrawBlockProps) {
  const seedRef = useRef(form.values[id])
  const formRef = useRef(form)
  formRef.current = form
  const latestJson = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const initial = useDrawInitial(content, contentUrl, seedRef.current)
  const [bytes, setBytes] = useState(() => (isDrawValue(seedRef.current) ? seedRef.current.bytes : 0))
  const [fullscreen, setFullscreen] = useState(false)
  useFullscreenEscape(containerRef, fullscreen)

  const onSnapshot = useCallback(
    (json: string, b: number) => {
      latestJson.current = json
      setBytes(b)
      const value: DrawValue = { kind: 'draw', snapshot: json, bytes: b }
      formRef.current.setValue(id, value)
    },
    [id],
  )

  // Seed the canvas from the freshest local edit, falling back to the resolved
  // initial. Recomputed only when the agent redraws (initial.snapshot changes) --
  // NOT on fullscreen toggle (no remount) and not on every keystroke.
  const seedSnapshot = useMemo(
    () => (latestJson.current ? safeParse(latestJson.current) : initial.snapshot),
    [initial.snapshot],
  )

  // Freshest scene JSON for the save button (latest edit, else the resolved initial).
  const onSave = useCallback(() => {
    const scene = latestJson.current ?? (initial.snapshot ? JSON.stringify(initial.snapshot) : null)
    if (scene) void downloadScene(scene, 'drawing')
  }, [initial.snapshot])

  const over = bytes > DRAW_INLINE_MAX
  const hasScene = bytes > 0 || initial.snapshot != null
  const showChrome = !readOnly && !fullscreen

  const canvas = (
    <Suspense
      fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">Loading canvas...</div>}
    >
      <DrawCanvas
        key={initial.snapshot ? 'seeded' : 'blank'}
        initialSnapshot={seedSnapshot}
        readOnly={readOnly}
        onSnapshot={readOnly ? undefined : onSnapshot}
      />
    </Suspense>
  )

  const header = (
    <div className="flex items-center justify-between gap-2 px-0.5 pb-1">
      <span className="text-xs font-medium text-muted-foreground">{label || (readOnly ? 'Drawing' : 'Draw')}</span>
      <div className="flex items-center gap-2">
        {bytes > 0 && (
          <span className={cn('text-[10px] tabular-nums', over ? 'text-amber-500' : 'text-muted-foreground')}>
            {sizeLabel(bytes)}
            {over && ' -- saved as file'}
          </span>
        )}
        {hasScene && (
          <button
            type="button"
            onClick={onSave}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Save drawing (.excalidraw + PNG)"
          >
            <Download className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setFullscreen(f => !f)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className={cn(fullscreen && 'fixed inset-0 z-[100] flex flex-col bg-background p-3')}>
      {header}
      <div
        className={cn(
          'relative overflow-hidden rounded border border-border/40',
          showChrome && 'draw-chrome-hover',
          fullscreen ? 'min-h-0 flex-1' : 'bg-muted/10',
        )}
        style={fullscreen ? undefined : { height }}
      >
        {canvas}
      </div>
    </div>
  )
}

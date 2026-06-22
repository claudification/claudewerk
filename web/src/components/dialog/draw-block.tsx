/**
 * Draw block chrome: header (label + size meter + fullscreen toggle) wrapping the
 * lazily-loaded tldraw canvas. tldraw lives in draw-canvas.tsx and is React.lazy'd
 * here so its ~13MB chunk loads only when a Draw block paints (LAZY LOAD covenant).
 *
 * Size meter: a drawing over DRAW_INLINE_MAX is flagged ("large -- saved as file"),
 * because on submit draw-spill.ts uploads it to a blob and sends a URL reference
 * instead of inline JSON. The drawing is never lost, just parked in a shareable file.
 */

import { DRAW_INLINE_MAX, type DrawValue, isDrawValue } from '@shared/draw'
import { Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import type { DialogFormState } from './dialog-renderer'
import { useDrawInitial } from './use-draw-initial'

const DrawCanvas = lazy(() => import('./draw-canvas'))

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

  const initial = useDrawInitial(content, contentUrl, seedRef.current)
  const [bytes, setBytes] = useState(() => (isDrawValue(seedRef.current) ? seedRef.current.bytes : 0))
  const [fullscreen, setFullscreen] = useState(false)

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
  // initial. Recomputed only when fullscreen toggles (remount) or the agent
  // redraws (initial.snapshot changes) -- not on every keystroke.
  const seedSnapshot = useMemo(
    () => (latestJson.current ? safeParse(latestJson.current) : initial.snapshot),
    [fullscreen, initial.snapshot],
  )

  const over = bytes > DRAW_INLINE_MAX
  const canvas = (
    <Suspense
      fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">Loading canvas...</div>}
    >
      <DrawCanvas
        key={`${fullscreen ? 'fs' : 'inline'}:${initial.snapshot ? 'seeded' : 'blank'}`}
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

  if (fullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-[100] flex flex-col bg-background p-3">
        {header}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-border/40">{canvas}</div>
      </div>,
      document.body,
    )
  }

  return (
    <div>
      {header}
      <div className="relative overflow-hidden rounded border border-border/40 bg-muted/10" style={{ height }}>
        {canvas}
      </div>
    </div>
  )
}

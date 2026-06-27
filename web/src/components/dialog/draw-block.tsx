/**
 * Draw block chrome: header (label + size meter + save + fullscreen) wrapping the
 * lazily-loaded Excalidraw canvas (excalidraw-canvas.tsx, React.lazy'd so its chunk
 * loads only when a Draw block paints -- LAZY LOAD covenant).
 *
 * Two authoring modes, decided by the seed:
 *   - raw / freehand  -> canvas serializes the scene; submit `{kind:'draw'}` (phase 1).
 *   - DSL Scene (v:1) -> the agent authored compact shapes; the canvas expands them and
 *     submit reverses to `{kind:'excalidraw', scene, diff}` (see draw-submit-value).
 *
 * Fullscreen goes TRUE-viewport via `position:fixed` (use-fullscreen-escape) -- NOT a
 * portal -- so the canvas never remounts and the toggle is instant with pan/zoom kept.
 */

import { isDrawValue } from '@shared/draw'
import { isDslScene, type Scene } from '@shared/draw-dsl'
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { DialogFormState } from './dialog-renderer'
import { DrawBlockHeader } from './draw-block-header'
import { downloadScene } from './draw-export'
import { buildDrawValue } from './draw-submit-value'
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

  // The reverse baseline is the agent's DSL Scene from `content` (stable across reloads /
  // restored edits, unlike the canvas seed which becomes a raw snapshot once the user
  // draws). null = a plain freehand/raw block -> the phase-1 `{kind:'draw'}` path.
  const dslBase = useMemo<Scene | null>(() => {
    if (content === undefined) return isDslScene(initial.snapshot) ? (initial.snapshot as Scene) : null
    const parsed = safeParse(content)
    return isDslScene(parsed) ? (parsed as Scene) : null
  }, [content, initial.snapshot])

  const onSnapshot = useCallback(
    (json: string, b: number) => {
      latestJson.current = json
      setBytes(b)
      formRef.current.setValue(id, buildDrawValue(json, b, dslBase))
    },
    [id, dslBase],
  )

  // When the agent redraws (initial.snapshot reference changes) drop the stale local
  // edit so the canvas re-seeds from the new content -- the comment->redraw loop.
  const lastInitial = useRef(initial.snapshot)
  if (lastInitial.current !== initial.snapshot) {
    lastInitial.current = initial.snapshot
    latestJson.current = null
  }

  // Seed the canvas from the freshest local edit, else the resolved initial (a DSL Scene
  // expands; a raw scene seeds directly). Recomputed only on redraw -- NOT on fullscreen
  // toggle or every keystroke.
  const seedSnapshot = useMemo(
    () => (latestJson.current ? safeParse(latestJson.current) : initial.snapshot),
    [initial.snapshot],
  )

  // Freshest scene JSON for the save button (latest edit, else the resolved initial).
  const onSave = useCallback(() => {
    const scene = latestJson.current ?? (initial.snapshot ? JSON.stringify(initial.snapshot) : null)
    if (scene) void downloadScene(scene, 'drawing')
  }, [initial.snapshot])

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

  return (
    <div ref={containerRef} className={cn(fullscreen && 'fixed inset-0 z-[100] flex flex-col bg-background p-3')}>
      <DrawBlockHeader
        label={label || (readOnly ? 'Drawing' : 'Draw')}
        bytes={bytes}
        hasScene={hasScene}
        fullscreen={fullscreen}
        onSave={onSave}
        onToggleFullscreen={() => setFullscreen(f => !f)}
      />
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

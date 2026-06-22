/**
 * MermaidLightbox -- full-screen pan/zoom viewer for a rendered Mermaid SVG.
 *
 * Mounted once at the app root (lazyModule-gated on the open signal) so it
 * survives transcript virtualizer remounts, same pattern as MediaLightbox.
 * Opens via openMermaidLightbox(svg) from markdown.tsx's click delegate.
 * Inline diagrams shrink to column width; this pops them out legible with
 * drag-to-pan, wheel/pinch zoom, +/- buttons, and fit/reset.
 */

import { Maximize2, Minus, Plus, Scan, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef } from 'react'
import { usePanZoom } from '@/hooks/use-pan-zoom'
import { cn, haptic } from '@/lib/utils'
import { useMermaidLightbox } from './mermaid-lightbox-bus'

// Consumed via app.tsx's lazyModule string dynamic import, which fallow can't
// trace (same false positive as every other lazyModule'd component).
// fallow-ignore-next-line unused-export
export function MermaidLightbox() {
  const { open, svg, close } = useMermaidLightbox()
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { scale, transform, fit, reset, zoomBy, handlers } = usePanZoom(containerRef, contentRef)

  // Fit the diagram to the viewport once it (and the portal) are painted.
  useEffect(() => {
    if (!open || !svg) return
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [open, svg, fit])

  const btn =
    'flex items-center justify-center size-8 rounded text-foreground/80 hover:text-foreground hover:bg-muted/50 transition-colors'

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={v => {
        if (!v) close()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-[100] bg-black/90',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-0 z-[100] flex flex-col focus:outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Mermaid diagram</DialogPrimitive.Title>

          {/* Pan/zoom surface. touch-none so the browser doesn't hijack
              pinch/drag for its own scroll-zoom. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pan/zoom surface, keyboard handled via dialog */}
          <div
            ref={containerRef}
            className="relative flex-1 overflow-hidden touch-none cursor-grab active:cursor-grabbing"
            {...handlers}
            onClick={e => {
              if (e.target === e.currentTarget) close()
            }}
          >
            <div
              ref={contentRef}
              className="absolute left-0 top-0 origin-top-left will-change-transform [&_svg]:block [&_svg]:max-w-none"
              style={{ transform }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG rendered by beautiful-mermaid from trusted CC transcript
              // react-doctor-disable-next-line react-doctor/no-danger
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>

          {/* Toolbar */}
          <div
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1.5 rounded-lg',
              'bg-background/80 backdrop-blur border border-border/50 font-mono text-[11px]',
            )}
          >
            <button type="button" className={btn} onClick={() => zoomBy(1 / 1.25)} title="Zoom out">
              <Minus className="size-4" />
            </button>
            <span className="w-12 text-center text-muted-foreground tabular-nums">{Math.round(scale * 100)}%</span>
            <button type="button" className={btn} onClick={() => zoomBy(1.25)} title="Zoom in">
              <Plus className="size-4" />
            </button>
            <div className="h-4 w-px bg-border/60 mx-1" />
            <button type="button" className={btn} onClick={fit} title="Fit to screen">
              <Scan className="size-4" />
            </button>
            <button type="button" className={btn} onClick={reset} title="Actual size (100%)">
              <Maximize2 className="size-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              haptic('tap')
              close()
            }}
            className={cn(btn, 'absolute top-4 right-4 bg-background/80 backdrop-blur border border-border/50')}
            title="Close (Esc)"
          >
            <X className="size-4" />
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

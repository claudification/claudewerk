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
import { isPerfEnabled, record } from '@/lib/perf-metrics'
import { cn, haptic } from '@/lib/utils'
import { useMermaidLightbox } from './mermaid-lightbox-bus'
import { MaybeProfiler } from './perf-profiler'

// Consumed via app.tsx's lazyModule string dynamic import, which fallow can't
// trace (same false positive as every other lazyModule'd component).
// fallow-ignore-next-line unused-export
export function MermaidLightbox() {
  const { open, svg, close } = useMermaidLightbox()
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { scale, fit, reset, zoomBy, handlers } = usePanZoom(containerRef, contentRef)

  // Fit the diagram to the viewport once it (and the portal) are painted.
  useEffect(() => {
    if (!open || !svg) return
    // biome-ignore lint/suspicious/noFocusedTests: `fit` is a local fit-to-viewport function, not a focused test
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [open, svg, fit])

  // --- PERF DIAGNOSTICS (gated by the perf monitor toggle; zero-cost when off).
  // On open: record diagram complexity (DOM node count + intrinsic SVG size).
  // Heavy vector content + high zoom = the classic per-frame re-rasterize that
  // makes pan/zoom crawl, so we correlate `mermaid.svg` here with the frame
  // cadence recorded in usePanZoom. ALSO: a MutationObserver on the content div
  // counting childList replacements -- if `dangerouslySetInnerHTML` re-injects
  // (re-parses) the SVG on every transform tick, `mermaid.reinject` fires
  // repeatedly during a gesture and THAT is the bug instead of paint cost.
  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (!open || !svg || !isPerfEnabled()) return
    const el = contentRef.current
    if (!el) return
    const id = requestAnimationFrame(() => {
      const svgEl = el.querySelector('svg')
      const nodes = el.querySelectorAll('*').length
      const w = svgEl ? Math.round(svgEl.getBoundingClientRect().width) : 0
      const h = svgEl ? Math.round(svgEl.getBoundingClientRect().height) : 0
      record('scroll', 'mermaid.svg', nodes, `nodes=${nodes} intrinsic=${w}x${h} chars=${svg.length}`)
    })
    const obs = new MutationObserver(muts => {
      const childListHits = muts.filter(m => m.type === 'childList').length
      if (childListHits) record('scroll', 'mermaid.reinject', childListHits, 'svg DOM replaced (re-parse)')
    })
    obs.observe(el, { childList: true })
    return () => {
      cancelAnimationFrame(id)
      obs.disconnect()
    }
  }, [open, svg])

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
          <MaybeProfiler id="mermaid-lightbox">
            <div
              role="button"
              tabIndex={0}
              ref={containerRef}
              className="relative flex-1 overflow-hidden touch-none cursor-grab active:cursor-grabbing"
              {...handlers}
              onClick={e => {
                if (e.target === e.currentTarget) close()
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  close()
                }
              }}
            >
              {/* transform is written imperatively by usePanZoom (see its header) --
                  NOT bound here, so a per-event re-render never reaches this div. */}
              <div
                ref={contentRef}
                className="absolute left-0 top-0 origin-top-left will-change-transform [&_svg]:block [&_svg]:max-w-none"
                // react-doctor-disable-next-line react-doctor/no-danger
                // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG rendered by beautiful-mermaid from trusted CC transcript
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </MaybeProfiler>

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

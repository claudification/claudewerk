/**
 * Mermaid-lightbox bus. Pure non-component module so the MermaidLightbox
 * component file stays Fast-Refresh clean (mirrors media-lightbox-bus).
 *
 * Mermaid diagrams render imperatively in markdown.tsx (DOM swap, not React).
 * Clicking a rendered `.mermaid-container` reads its `<svg>` markup and pushes
 * it here; the app-root MermaidLightbox pops it into a pan/zoom overlay so
 * complex diagrams are legible instead of squashed to column width.
 */

import { create } from 'zustand'

interface MermaidLightboxState {
  open: boolean
  /** Rendered SVG markup (outerHTML of the diagram's <svg>). */
  svg: string
  show: (svg: string) => void
  close: () => void
}

export const useMermaidLightbox = create<MermaidLightboxState>(set => ({
  open: false,
  svg: '',
  show: svg => set({ open: true, svg }),
  close: () => set({ open: false }),
}))

export function openMermaidLightbox(svg: string) {
  useMermaidLightbox.getState().show(svg)
}

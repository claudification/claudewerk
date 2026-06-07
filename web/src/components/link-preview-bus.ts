/**
 * Link-preview pane bus. Pure non-component module (Fast-Refresh clean) so the
 * pane component can subscribe without circular imports.
 *
 * The pane exists to break the mobile-PWA navigation trap: a standalone PWA has
 * no back button, so tapping an external link can navigate the whole webview
 * away with no way back to CLAUDEWERK. The markdown click delegate intercepts
 * external taps on mobile, preventDefaults the navigation, and calls
 * openLinkPreview() to show the URL in a contained bottom sheet (CLOSE always
 * returns you here; SHARE escapes to the real browser).
 */

import { create } from 'zustand'

interface LinkPreviewState {
  open: boolean
  url: string
  show: (url: string) => void
  close: () => void
}

export const useLinkPreview = create<LinkPreviewState>(set => ({
  open: false,
  url: '',
  show: url => set({ open: true, url }),
  close: () => set({ open: false }),
}))

export function openLinkPreview(url: string) {
  useLinkPreview.getState().show(url)
}

export interface LinkPreviewData {
  url: string
  frameable: boolean
  title?: string
  description?: string
  image?: string
  favicon?: string
  siteName?: string
  error?: string
}

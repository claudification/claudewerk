/**
 * Media-lightbox bus + URL helpers. Pure non-component module so the
 * MediaLightbox component file can stay Fast-Refresh clean.
 */

import { create } from 'zustand'

export type MediaKind = 'image' | 'video'

interface MediaLightboxState {
  open: boolean
  src: string
  kind: MediaKind
  alt?: string
  show: (src: string, kind: MediaKind, alt?: string) => void
  close: () => void
}

export const useMediaLightbox = create<MediaLightboxState>(set => ({
  open: false,
  src: '',
  kind: 'image',
  alt: undefined,
  show: (src, kind, alt) => set({ open: true, src, kind, alt }),
  close: () => set({ open: false }),
}))

export function openMediaLightbox(src: string, kind: MediaKind, alt?: string) {
  useMediaLightbox.getState().show(src, kind, alt)
}

export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url, 'https://x.invalid')
    const parts = u.pathname.split('/')
    return parts[parts.length - 1] || url
  } catch {
    return url
  }
}

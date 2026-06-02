/**
 * Markdown viewer store - a single global "view this project file" modal.
 *
 * A relative file link in any rendered markdown (transcript or task body) opens
 * the file THROUGH THE SENTINEL (project-scoped, no live agent host). The path
 * is resolved relative to the project root (the project URI's path segment).
 */

import { create } from 'zustand'

interface MarkdownViewerState {
  /** Open target, or null when closed. */
  current: { projectUri: string; relPath: string } | null
  open: (projectUri: string, relPath: string) => void
  close: () => void
}

export const useMarkdownViewer = create<MarkdownViewerState>(set => ({
  current: null,
  open: (projectUri, relPath) => set({ current: { projectUri, relPath } }),
  close: () => set({ current: null }),
}))

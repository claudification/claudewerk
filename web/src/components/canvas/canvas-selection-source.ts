/**
 * Reading "what is selected right now" off a live canvas, for the chat.
 *
 * A module registry rather than props for the same reason canvas-collab-bus and
 * canvas-peer-id are: the Excalidraw API is bound deep in the canvas surface,
 * and the chat panel that needs it sits in the floating island -- different
 * branches, several layers apart.
 *
 * Deliberately NOT part of CollabApi: a selection is not collaboration state.
 * It is per-viewer, never broadcast, and read only at the instant the user
 * presses send.
 */

import { type CanvasSelection, summarizeSelection } from '@shared/canvas-selection'

/** The slice of the Excalidraw API a selection needs. */
export interface SelectionSource {
  getSceneElements(): readonly unknown[]
  getAppState(): { selectedElementIds?: Record<string, boolean> }
}

const sources = new Map<string, SelectionSource>()

export function setSelectionSource(canvasId: string, api: SelectionSource | null): void {
  if (api) sources.set(canvasId, api)
  else sources.delete(canvasId)
}

/**
 * What the user has selected on this canvas, summarized for the agent.
 *
 * Returns an empty selection when the canvas is not mounted or nothing is
 * picked -- "nothing selected" is a real answer the agent acts on (it asks what
 * you mean rather than guessing at the whole canvas), so this never returns
 * undefined for the empty case.
 */
export function readCanvasSelection(canvasId: string): CanvasSelection {
  const api = sources.get(canvasId)
  if (!api) return { count: 0, elements: [], truncated: false }
  try {
    const selectedIds = Object.entries(api.getAppState().selectedElementIds ?? {})
      .filter(([, picked]) => picked)
      .map(([id]) => id)
    return summarizeSelection(api.getSceneElements() as never, selectedIds)
  } catch {
    // A selection must never cost the user their message.
    return { count: 0, elements: [], truncated: false }
  }
}

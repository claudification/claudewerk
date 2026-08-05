/**
 * Pure helpers for merging inbound canvas-multiplayer messages into local state.
 * Kept out of the React hook so they're directly unit-testable (and so the hook
 * closures stay thin).
 */

import { isDslScene, type Scene } from '@shared/draw-dsl'
import type { CanvasPeer } from '@shared/protocol'

/** Excalidraw collaborator shape (the slice we populate for remote cursors).
 *  pointer.tool + button are what Excalidraw keys the remote LASER trail off:
 *  it only draws (and continues) a trail while tool==='laser' and button==='down'. */
export interface RemoteCollaborator {
  username: string
  color: { background: string; stroke: string }
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  button?: 'up' | 'down'
}

/** Build a collaborator entry from a canvas_pointer message (with defaults). */
export function pointerCollaborator(msg: Record<string, unknown>): RemoteCollaborator {
  return {
    username: (msg.name as string) || 'guest',
    color: { background: (msg.color as string) || '#888', stroke: '#1e293b' },
    pointer: { x: Number(msg.x) || 0, y: Number(msg.y) || 0, tool: msg.tool === 'laser' ? 'laser' : 'pointer' },
    button: msg.button === 'down' ? 'down' : 'up',
  }
}

/** Resolve an inbound pointer message to the collaborator entry to store, or
 *  null when it should be ignored (no peerId, or it's our own cursor echo). */
export function peerToApply(
  msg: Record<string, unknown>,
  ownPeerId: string | null,
): { id: string; collaborator: RemoteCollaborator } | null {
  const id = msg.peerId as string
  if (!id || id === ownPeerId) return null
  return { id, collaborator: pointerCollaborator(msg) }
}

function parseJson(sceneJson: unknown): unknown {
  if (typeof sceneJson !== 'string') return null
  try {
    return JSON.parse(sceneJson)
  } catch {
    return null
  }
}

/** Parse the elements array out of a raw Excalidraw scene-delta payload, or null
 *  if unusable. Null means "keep the current scene" -- and an ABSENT `elements`
 *  counts as unusable, not as an empty canvas. Returning [] there let a payload
 *  that simply isn't a raw scene (an agent's draw-dsl scene, see parseDslScene)
 *  wipe the receiver's canvas, and the client then autosaved the blank over the
 *  real drawing (2026-08-05). A genuine clear still arrives as `elements: []`. */
export function parseSceneElements(sceneJson: unknown): readonly unknown[] | null {
  const scene = parseJson(sceneJson) as { elements?: unknown } | null
  return Array.isArray(scene?.elements) ? (scene.elements as readonly unknown[]) : null
}

/** Parse an agent-authored draw-dsl scene out of a delta payload, or null when it
 *  isn't one. These arrive from canvas_update_scene and must be EXPANDED before
 *  they can be applied -- the same thing the open path does when seeding. */
export function parseDslScene(sceneJson: unknown): Scene | null {
  const scene = parseJson(sceneJson)
  return isDslScene(scene) ? scene : null
}

/** Parse the image `files` (BinaryFileData values) out of a scene-delta payload.
 *  Excalidraw keeps image bytes in a `files` map applied via addFiles(), SEPARATE
 *  from elements/updateScene. A remote peer that applies the element but not the
 *  file renders a missing-image placeholder that then gets pruned + echoed back --
 *  the image blinks in and out. Returns [] on absence/malformed (never throws). */
export function parseSceneFiles(sceneJson: unknown): unknown[] {
  if (typeof sceneJson !== 'string') return []
  try {
    const scene = JSON.parse(sceneJson) as { files?: Record<string, unknown> }
    return scene.files ? Object.values(scene.files) : []
  } catch {
    return []
  }
}

/** The fileIds referenced by (live, non-deleted) image elements in a delta. These
 *  are the image bytes a receiver must have loaded before applying the elements,
 *  or Excalidraw prunes the fileless image and it blinks. */
export function imageFileIds(elements: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const el of elements) {
    const e = el as { type?: string; fileId?: string; isDeleted?: boolean }
    if (e.type === 'image' && typeof e.fileId === 'string' && !e.isDeleted) ids.push(e.fileId)
  }
  return ids
}

/** Drop collaborators no longer in the presence roster (mutates the map). */
export function prunePeers(collaborators: Map<string, RemoteCollaborator>, roster: CanvasPeer[]): void {
  for (const id of [...collaborators.keys()]) {
    if (!roster.some(p => p.peerId === id)) collaborators.delete(id)
  }
}

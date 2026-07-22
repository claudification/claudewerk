/**
 * canvasId -> this browser's room peerId, for the SAVE path.
 *
 * Scene writes reach the broker two ways -- `canvas_scene_delta` over the WS and
 * the debounced `PUT /api/canvases/:id/scene` autosave -- and since both now
 * publish into the live room, the PUT has to say who made it. Without a peerId
 * the broker treats it as a server-side (agent) write and broadcasts it to
 * EVERYONE, including this tab: we would then re-apply our own snapshot, by then
 * up to the debounce interval old, wiping every stroke drawn since.
 *
 * A module registry rather than props because the writer (canvas-editor-io) and
 * the owner of the id (useCanvasCollab, via canvas_join_ack) sit in different
 * branches of the tree with three layers between them -- the same reason
 * canvas-collab-bus is a module registry.
 */

const peerIds = new Map<string, string>()

export function setCanvasPeerId(canvasId: string, peerId: string): void {
  peerIds.set(canvasId, peerId)
}

export function clearCanvasPeerId(canvasId: string): void {
  peerIds.delete(canvasId)
}

/** This tab's peerId in a canvas room, or undefined when it never joined (a
 *  solo editor with no live socket still saves -- it just has no echo to drop). */
export function getCanvasPeerId(canvasId: string): string | undefined {
  return peerIds.get(canvasId)
}

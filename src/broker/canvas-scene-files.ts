/**
 * Scene <-> image-bytes helpers for the scene-write chokepoint.
 *
 * Excalidraw keeps image bytes in a scene's `files` map (base64 dataURLs) beside
 * the elements that reference them by `fileId`. That map is why an autosaved
 * scene can be megabytes. Two scene shapes therefore exist ON PURPOSE, and this
 * module is the seam between them:
 *
 *   DISK  FAT  -- files inline, so a load or a room join is self-contained.
 *   WIRE  LEAN -- files stripped; peers pull the bytes they lack from the
 *                 per-canvas file slot (canvas-files.ts) by fileId.
 *
 * DISK IS THE SOURCE OF TRUTH AND IS NEVER STRIPPED. It is deliberately
 * independent of the upload slot: the browser's fat PUT fires BEFORE its
 * best-effort upload (which may throw and roll back), and legacy / imported /
 * pasted scenes carry inline bytes that were never uploaded at all. The slot can
 * LACK bytes disk has, so only the broadcast copy is ever thinned.
 */

import { hasCanvasImage, isSafeFileId } from './canvas-files'
import { readScene } from './canvas-scenes'

interface RawScene {
  elements?: unknown[]
  files?: Record<string, unknown>
}

/** Parse a scene, or null when it is not a JSON object. A malformed scene is
 *  never rewritten here -- callers pass it through untouched so the sanitizer
 *  (the one place that owns rejection) stays the only judge of validity. */
function parseScene(raw: string): RawScene | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as RawScene) : null
  } catch {
    return null
  }
}

/** The fileIds a scene carries bytes for inline. */
function inlineFileIds(raw: string | null): Set<string> {
  const scene = raw === null ? null : parseScene(raw)
  return new Set(Object.keys(scene?.files ?? {}))
}

/**
 * The WIRE copy of a scene: same everything, `files` emptied.
 *
 * Returns `raw` untouched when there is nothing to strip (already lean, or
 * unparseable), so the common lean path costs no re-serialize.
 */
export function stripSceneFiles(raw: string): string {
  const scene = parseScene(raw)
  const files = scene?.files
  if (!scene || !files || typeof files !== 'object' || Object.keys(files).length === 0) return raw
  return JSON.stringify({ ...scene, files: {} })
}

/** The fileId of a LIVE image element, or null for anything else.
 *
 *  Tombstones (isDeleted) are skipped on purpose: their bytes are legitimately
 *  gone, nothing renders them, and dropping them would rewrite the deletion
 *  history Excalidraw's LWW reconcile needs. */
function liveImageFileId(el: unknown): string | null {
  if (!el || typeof el !== 'object') return null
  const e = el as { type?: unknown; fileId?: unknown; isDeleted?: unknown }
  if (e.type !== 'image' || e.isDeleted === true) return null
  return typeof e.fileId === 'string' && e.fileId ? e.fileId : null
}

/**
 * Can this canvas serve bytes for `fileId` from anywhere? Cheapest source first;
 * the persisted scene is only read when the first two miss, which is the
 * anomalous case.
 *
 * The persisted-scene check is load-bearing, not belt-and-braces: an image whose
 * upload to the slot FAILED is inline on disk and nowhere else, and it must not
 * read as dangling -- the accepted outcome there is a live 404 that a reload
 * heals, never the element disappearing.
 */
function hasBytesAnywhere(
  canvasId: string,
  fileId: string,
  inline: Set<string>,
  persisted: () => Set<string>,
): boolean {
  if (inline.has(fileId)) return true
  if (isSafeFileId(fileId) && hasCanvasImage(canvasId, fileId)) return true
  return persisted().has(fileId)
}

export interface DanglingScan {
  /** The scene minus unresolvable image elements (the input string when none). */
  json: string
  /** fileIds that resolved to no bytes anywhere. */
  dropped: string[]
}

/**
 * Drop image elements whose `fileId` resolves to no bytes ANYWHERE -- not inline
 * in this write, not in the file slot, not inline in the persisted scene.
 *
 * Such an element is unrenderable by construction, and broadcasting it is how an
 * image gets DELETED: a peer fetches null, Excalidraw prunes the fileless image,
 * and that prune echoes back through this same chokepoint as a write. Losing the
 * element costs nothing because there were never any bytes behind it.
 *
 * FOR THE WIRE COPY ONLY. Persistence stays verbatim -- see the module header.
 */
export function dropDanglingImages(canvasId: string, raw: string): DanglingScan {
  const scene = parseScene(raw)
  const elements = Array.isArray(scene?.elements) ? scene.elements : null
  if (!scene || !elements) return { json: raw, dropped: [] }

  const inline = new Set(Object.keys(scene.files ?? {}))
  let persistedIds: Set<string> | null = null
  const persisted = (): Set<string> => {
    if (persistedIds === null) persistedIds = inlineFileIds(readScene(canvasId))
    return persistedIds
  }

  const dropped: string[] = []
  const kept = elements.filter(el => {
    const fileId = liveImageFileId(el)
    if (fileId === null || hasBytesAnywhere(canvasId, fileId, inline, persisted)) return true
    dropped.push(fileId)
    return false
  })
  if (dropped.length === 0) return { json: raw, dropped }
  return { json: JSON.stringify({ ...scene, elements: kept }), dropped }
}

/**
 * The full DISK -> WIRE transform: both thinnings, in the order they compose.
 *
 * This is what a room is sent for a scene write, and it is ONLY ever the
 * broadcast copy. Persistence takes the caller's scene verbatim.
 */
export function toWireScene(canvasId: string, sceneJson: string): string {
  const scan = dropDanglingImages(canvasId, sceneJson)
  if (scan.dropped.length > 0) {
    console.log(
      `[canvas] wire DROP ${canvasId.slice(0, 12)} ${scan.dropped.length} image element(s) with no bytes ` +
        `anywhere (fileIds ${scan.dropped.map(id => id.slice(0, 8)).join(',')}); disk keeps them`,
    )
  }
  return stripSceneFiles(scan.json)
}

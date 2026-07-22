/**
 * Canvas image file IO -- DURABLE per-canvas image bytes, keyed by Excalidraw's
 * fileId, SEPARATE from the scene JSON.
 *
 * Excalidraw keeps image bytes in a `files` map (a BinaryFileData per fileId),
 * distinct from `elements`. Inlining them as base64 in every scene delta floods
 * the WS (the backpressure hazard). Instead each image is uploaded ONCE to a slot
 * here; the scene carries only the element's `fileId`, and peers fetch the bytes
 * by id. Layout, mirroring canvas-scenes.ts (durable, NOT the reaped blob store):
 *
 *   {cacheDir}/canvas-files/{canvasId}/{fileId}
 *
 * Each file stores the self-describing dataURL string ("data:<mime>;base64,..."),
 * so a fetch reconstructs the whole BinaryFileData without a sidecar. Overwrite-
 * in-place, no per-file GC; the whole {canvasId}/ dir is removed on canvas delete.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

let filesRoot = ''

/** Idempotent: ensure {cacheDir}/canvas-files/ exists. Called from initCanvasStore. */
export function initCanvasFiles(cacheDir: string): void {
  filesRoot = resolve(cacheDir, 'canvas-files')
  mkdirSync(filesRoot, { recursive: true })
}

/**
 * fileId is CLIENT-supplied (an Excalidraw file id), so it is untrusted input in
 * a filesystem path -- validate it to a flat token before it ever touches join().
 * Excalidraw ids are long alphanumeric; this rejects `.`/`/`/`\` and traversal.
 */
export function isSafeFileId(fileId: unknown): fileId is string {
  return typeof fileId === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(fileId)
}

function canvasDir(canvasId: string): string {
  return join(filesRoot, canvasId)
}
function imagePath(canvasId: string, fileId: string): string {
  return join(canvasDir(canvasId), fileId)
}

/** Store an image's dataURL for a canvas (overwrite). Caller MUST have validated
 *  fileId via isSafeFileId and confirmed the canvas exists. */
export function writeCanvasImage(canvasId: string, fileId: string, dataURL: string): void {
  mkdirSync(canvasDir(canvasId), { recursive: true })
  writeFileSync(imagePath(canvasId, fileId), dataURL)
}

/** Read an image's stored dataURL, or null if this canvas has no such file. */
export function readCanvasImage(canvasId: string, fileId: string): string | null {
  const p = imagePath(canvasId, fileId)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

export function hasCanvasImage(canvasId: string, fileId: string): boolean {
  return existsSync(imagePath(canvasId, fileId))
}

/** Remove every image for a canvas (on canvas delete). Best-effort. */
export function deleteCanvasImages(canvasId: string): void {
  rmSync(canvasDir(canvasId), { recursive: true, force: true })
}

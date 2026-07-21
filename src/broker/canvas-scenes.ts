/**
 * Canvas scene file IO -- DURABLE per-canvas storage.
 *
 * Excalidraw scenes for hosted canvases must NOT live in the shared blob store:
 * that dir is content-addressed AND reaped after 7 days (file-reaper.ts), so a
 * canvas would silently vanish. Instead each canvas owns two files under
 * {cacheDir}/canvas-scenes/, keyed by the stable canvas id:
 *
 *   {id}.excalidraw   the serialized scene JSON (overwritten on every save)
 *   {id}.png          an optional thumbnail (PNG bytes)
 *
 * Overwrite-in-place means no GC and no orphaned blobs. The SQLite registry
 * (canvas-store.ts) holds only metadata + a pointer-by-id to these files.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Empty-scene fallback for a canvas with no stored scene yet -- the baseline a
 *  tier check compares against on the very first guest write. */
export const BLANK_SCENE = '{"type":"excalidraw","elements":[],"appState":{}}'

let sceneDir = ''

/** Idempotent: ensure {cacheDir}/canvas-scenes/ exists. Called from initCanvasStore. */
export function initCanvasScenes(cacheDir: string): void {
  sceneDir = resolve(cacheDir, 'canvas-scenes')
  mkdirSync(sceneDir, { recursive: true })
}

function scenePath(id: string): string {
  return join(sceneDir, `${id}.excalidraw`)
}
function thumbPath(id: string): string {
  return join(sceneDir, `${id}.png`)
}

/** Write the scene JSON for a canvas (overwrite). Returns the byte length. */
export function writeScene(id: string, json: string): number {
  writeFileSync(scenePath(id), json)
  return Buffer.byteLength(json)
}

/** Read a canvas scene JSON, or null if none stored yet (blank canvas). */
export function readScene(id: string): string | null {
  const p = scenePath(id)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

/** Store a thumbnail PNG (raw bytes). */
export function writeThumb(id: string, bytes: Uint8Array): void {
  writeFileSync(thumbPath(id), bytes)
}

/** Read a thumbnail PNG, or null if none. */
export function readThumb(id: string): Buffer | null {
  const p = thumbPath(id)
  if (!existsSync(p)) return null
  return readFileSync(p)
}

export function hasThumb(id: string): boolean {
  return existsSync(thumbPath(id))
}

/** Remove both files for a canvas (on delete). Best-effort. */
export function deleteSceneFiles(id: string): void {
  rmSync(scenePath(id), { force: true })
  rmSync(thumbPath(id), { force: true })
}

/**
 * The DISK-fat / WIRE-lean seam (canvas-scene-files.ts).
 *
 * Two rules are pinned here because getting either backwards loses image bytes:
 *   - stripping only ever produces the WIRE copy, never touching the input;
 *   - an image element is "dangling" ONLY when its bytes exist nowhere -- not
 *     inline, not in the file slot, not inline in the persisted scene. An
 *     upload that FAILED leaves bytes on disk and nowhere else, and that case
 *     must survive (a live 404 a reload heals), not be dropped.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCanvasImage } from './canvas-files'
import { dropDanglingImages, stripSceneFiles, toWireScene } from './canvas-scene-files'
import { closeCanvasStore, createCanvas, initCanvasStore, saveCanvasScene } from './canvas-store'

const PROJECT = 'claude://default/Users/x/proj'
const PNG = 'data:image/png;base64,aGk='

let dir: string
let canvasId: string

/** A scene with one image element (fileId `fid`) plus optional inline bytes. */
function imageScene(fid: string, inline: boolean, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'excalidraw',
    elements: [
      { id: 'img1', type: 'image', fileId: fid, ...extra },
      { id: 'rect1', type: 'rectangle' },
    ],
    files: inline ? { [fid]: { id: fid, dataURL: PNG, mimeType: 'image/png' } } : {},
  })
}

function elementIds(json: string): string[] {
  return (JSON.parse(json) as { elements: { id: string }[] }).elements.map(e => e.id)
}

function fileKeys(json: string): string[] {
  return Object.keys((JSON.parse(json) as { files?: Record<string, unknown> }).files ?? {})
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-scene-files-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C', sceneJson: '{"type":"excalidraw","elements":[]}' }).id
})

afterEach(() => {
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

test('stripSceneFiles empties the files map and leaves everything else alone', () => {
  const fat = imageScene('fileA', true)
  const lean = stripSceneFiles(fat)

  expect(fileKeys(fat)).toEqual(['fileA']) // input untouched
  expect(fileKeys(lean)).toEqual([])
  expect(elementIds(lean)).toEqual(['img1', 'rect1'])
})

test('stripSceneFiles returns an already-lean scene byte-identical (no re-serialize)', () => {
  // Whitespace makes the identity real: a scene that got re-serialized would come
  // back minified. Agent-authored scenes have no `files` key at all, and the
  // common WS delta has an empty one -- neither is worth a parse+stringify.
  const noFilesKey = '{\n  "type": "excalidraw",\n  "elements": []\n}'
  const emptyFiles = '{\n  "type": "excalidraw",\n  "elements": [],\n  "files": {}\n}'

  expect(stripSceneFiles(noFilesKey)).toBe(noFilesKey)
  expect(stripSceneFiles(emptyFiles)).toBe(emptyFiles)
})

test('stripSceneFiles passes malformed JSON through instead of rewriting it', () => {
  expect(stripSceneFiles('not json')).toBe('not json')
})

test('an image whose bytes are inline in THIS write is not dangling', () => {
  const scan = dropDanglingImages(canvasId, imageScene('fileA', true))
  expect(scan.dropped).toEqual([])
  expect(elementIds(scan.json)).toEqual(['img1', 'rect1'])
})

test('an image whose bytes are in the file slot is not dangling', () => {
  writeCanvasImage(canvasId, 'fileA', PNG)
  const scan = dropDanglingImages(canvasId, imageScene('fileA', false))
  expect(scan.dropped).toEqual([])
})

test('an image whose upload FAILED -- bytes inline on disk only -- is not dangling', () => {
  // The exact shape of a rolled-back upload: the fat PUT landed, the slot has
  // nothing, and the follow-up WS delta carries the fileId with no bytes.
  saveCanvasScene(canvasId, imageScene('fileA', true))
  const scan = dropDanglingImages(canvasId, imageScene('fileA', false))

  expect(scan.dropped).toEqual([])
  expect(elementIds(scan.json)).toEqual(['img1', 'rect1'])
})

test('an image whose bytes exist NOWHERE is dropped, and only that element', () => {
  const scan = dropDanglingImages(canvasId, imageScene('ghost', false))

  expect(scan.dropped).toEqual(['ghost'])
  expect(elementIds(scan.json)).toEqual(['rect1'])
})

test('a deleted image element is kept even with no bytes anywhere', () => {
  // Tombstones are how Excalidraw's LWW reconcile propagates a deletion; their
  // bytes are legitimately gone and nothing renders them.
  const scan = dropDanglingImages(canvasId, imageScene('ghost', false, { isDeleted: true }))
  expect(scan.dropped).toEqual([])
  expect(elementIds(scan.json)).toEqual(['img1', 'rect1'])
})

test('an image element with no fileId yet is kept', () => {
  const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'img1', type: 'image', fileId: null }] })
  expect(dropDanglingImages(canvasId, scene).dropped).toEqual([])
})

test('toWireScene does both thinnings at once', () => {
  writeCanvasImage(canvasId, 'fileA', PNG)
  const fat = JSON.stringify({
    type: 'excalidraw',
    elements: [
      { id: 'ok', type: 'image', fileId: 'fileA' },
      { id: 'ghost', type: 'image', fileId: 'nobody' },
    ],
    files: { fileA: { id: 'fileA', dataURL: PNG } },
  })
  const wire = toWireScene(canvasId, fat)

  expect(fileKeys(wire)).toEqual([])
  expect(elementIds(wire)).toEqual(['ok'])
})

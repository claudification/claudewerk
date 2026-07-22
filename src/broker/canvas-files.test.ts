import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import {
  deleteCanvasImages,
  hasCanvasImage,
  initCanvasFiles,
  isSafeFileId,
  readCanvasImage,
  writeCanvasImage,
} from './canvas-files'

let cacheDir = ''
beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'canvas-files-'))
  initCanvasFiles(cacheDir)
})

describe('isSafeFileId (path-traversal guard on client-supplied ids)', () => {
  it('accepts real Excalidraw-shaped ids', () => {
    expect(isSafeFileId('a1B2c3_-XYZ')).toBe(true)
    expect(isSafeFileId('9f8e7d6c5b4a3f2e1d0c9b8a7654321000abcdef')).toBe(true)
  })
  it('rejects traversal, separators, dots and non-strings', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '.', '..', 'a.b', '', 'a b']) {
      expect(isSafeFileId(bad)).toBe(false)
    }
    expect(isSafeFileId(42)).toBe(false)
    expect(isSafeFileId(null)).toBe(false)
  })
})

describe('write/read/delete round-trip', () => {
  it('stores a dataURL under {cacheDir}/canvas-files/{canvasId}/{fileId} and reads it back', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    writeCanvasImage('cnv_x', 'file1', url)
    expect(hasCanvasImage('cnv_x', 'file1')).toBe(true)
    expect(readCanvasImage('cnv_x', 'file1')).toBe(url)
    // verify the actual on-disk location (contract other code + ops rely on)
    expect(existsSync(join(cacheDir, 'canvas-files', 'cnv_x', 'file1'))).toBe(true)
    expect(readFileSync(join(cacheDir, 'canvas-files', 'cnv_x', 'file1'), 'utf8')).toBe(url)
  })
  it('returns null for an image this canvas never stored', () => {
    expect(readCanvasImage('cnv_x', 'nope')).toBeNull()
    expect(hasCanvasImage('cnv_x', 'nope')).toBe(false)
  })
  it('deleteCanvasImages drops the whole canvas dir', () => {
    writeCanvasImage('cnv_y', 'f', 'data:image/png;base64,AAAA')
    deleteCanvasImages('cnv_y')
    expect(hasCanvasImage('cnv_y', 'f')).toBe(false)
    expect(existsSync(join(cacheDir, 'canvas-files', 'cnv_y'))).toBe(false)
  })
})

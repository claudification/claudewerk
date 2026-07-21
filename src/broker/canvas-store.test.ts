import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeCanvasScene } from './canvas-sanitize'
import { readScene, readThumb } from './canvas-scenes'
import {
  archiveCanvas,
  closeCanvasStore,
  createCanvas,
  deleteCanvas,
  getCanvas,
  getCanvasByToken,
  initCanvasStore,
  listCanvases,
  reapExpiredCanvasShares,
  renameCanvas,
  saveCanvasScene,
  setCanvasShare,
  validateCanvasShare,
} from './canvas-store'

const P = 'claude://default/Users/x/proj'
const Q = 'claude://default/Users/x/other'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-test-'))
  initCanvasStore(dir)
})
afterEach(() => {
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

const SCENE = JSON.stringify({ type: 'excalidraw', elements: [{ type: 'rectangle', id: 'a' }], appState: {} })

test('create + list: project-scoped, newest first', () => {
  const a = createCanvas(P, { name: 'Alpha', createdBy: 'jonas' })
  const b = createCanvas(P, { name: 'Beta', sceneJson: SCENE })
  createCanvas(Q, { name: 'Other' })

  const list = listCanvases(P)
  expect(list.map(c => c.name)).toEqual(['Beta', 'Alpha'])
  expect(list.find(c => c.id === a.id)?.createdBy).toBe('jonas')
  expect(list.find(c => c.id === b.id)?.sceneBytes).toBe(Buffer.byteLength(SCENE))
})

test('blank create stores no scene; seeded create persists it', () => {
  const blank = createCanvas(P, { name: 'Blank' })
  expect(blank.sceneBytes).toBe(0)
  expect(readScene(blank.id)).toBeNull()

  const seeded = createCanvas(P, { name: 'Seeded', sceneJson: SCENE })
  expect(readScene(seeded.id)).toBe(SCENE)
})

test('saveCanvasScene overwrites scene + stores thumbnail', () => {
  const c = createCanvas(P, { name: 'C' })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  saveCanvasScene(c.id, SCENE, png)
  expect(readScene(c.id)).toBe(SCENE)
  expect(getCanvas(c.id)?.hasThumb).toBe(true)
  expect(readThumb(c.id)).toEqual(Buffer.from(png))
})

test('rename + archive: archived drops out of list', () => {
  const c = createCanvas(P, { name: 'Old' })
  renameCanvas(c.id, 'New')
  expect(getCanvas(c.id)?.name).toBe('New')
  archiveCanvas(c.id, true)
  expect(listCanvases(P)).toHaveLength(0)
  expect(getCanvas(c.id)?.archivedAt).not.toBeNull()
})

test('share token round-trips by token and clears', () => {
  const c = createCanvas(P, { name: 'Shared' })
  setCanvasShare(c.id, 'tok_123', 'comment')
  const byTok = getCanvasByToken('tok_123')
  expect(byTok?.id).toBe(c.id)
  expect(byTok?.shared).toBe(true)
  expect(byTok?.shareTier).toBe('comment')
  setCanvasShare(c.id, null, null)
  expect(getCanvasByToken('tok_123')).toBeNull()
  expect(getCanvas(c.id)?.shared).toBe(false)
})

test('delete removes row and scene files', () => {
  const c = createCanvas(P, { name: 'Doomed', sceneJson: SCENE })
  expect(readScene(c.id)).toBe(SCENE)
  deleteCanvas(c.id)
  expect(getCanvas(c.id)).toBeNull()
  expect(readScene(c.id)).toBeNull()
})

test('sanitizer drops embeddable/iframe and unsafe links', () => {
  const dirty = JSON.stringify({
    type: 'excalidraw',
    elements: [
      { type: 'rectangle', id: 'keep' },
      { type: 'embeddable', id: 'drop', link: 'https://evil.example' },
      { type: 'iframe', id: 'drop2' },
      { type: 'text', id: 'jslink', link: 'javascript:alert(1)' },
      { type: 'text', id: 'safelink', link: 'https://ok.example' },
    ],
  })
  const res = sanitizeCanvasScene(dirty)
  expect(res.droppedElements).toBe(2)
  expect(res.strippedLinks).toBe(1)
  const scene = JSON.parse(res.json as string)
  const ids = scene.elements.map((e: { id: string }) => e.id)
  expect(ids).toEqual(['keep', 'jslink', 'safelink'])
  expect(scene.elements.find((e: { id: string }) => e.id === 'jslink').link).toBeNull()
  expect(scene.elements.find((e: { id: string }) => e.id === 'safelink').link).toBe('https://ok.example')
})

test('sanitizer rejects unparseable input', () => {
  expect(sanitizeCanvasScene('{not json').json).toBeNull()
})

// ─── timed shares (E1) ───────────────────────────────────────────────────────

test('share with no expiry resolves indefinitely', () => {
  const c = createCanvas(P, { name: 'C' })
  setCanvasShare(c.id, 'tok-forever', 'read')
  expect(validateCanvasShare('tok-forever')?.id).toBe(c.id)
  expect(getCanvas(c.id)?.shareExpiresAt).toBeUndefined()
})

test('share resolves before expiry and stops resolving after', () => {
  const c = createCanvas(P, { name: 'C' })
  setCanvasShare(c.id, 'tok-live', 'edit', Date.now() + 60_000)
  expect(validateCanvasShare('tok-live')?.id).toBe(c.id)

  setCanvasShare(c.id, 'tok-dead', 'edit', Date.now() - 1)
  expect(validateCanvasShare('tok-dead')).toBeNull()
  // ...even though the row itself is still there and still flagged shared.
  expect(getCanvasByToken('tok-dead')?.shared).toBe(true)
})

test('expired share is indistinguishable from an unknown token', () => {
  const c = createCanvas(P, { name: 'C' })
  setCanvasShare(c.id, 'tok-gone', 'read', Date.now() - 1)
  expect(validateCanvasShare('tok-gone')).toBeNull()
  expect(validateCanvasShare('never-existed')).toBeNull()
  expect(validateCanvasShare('')).toBeNull()
})

test('revoked share does not resolve even when unexpired', () => {
  const c = createCanvas(P, { name: 'C' })
  setCanvasShare(c.id, 'tok-revoke', 'edit', Date.now() + 60_000)
  setCanvasShare(c.id, null, null)
  expect(validateCanvasShare('tok-revoke')).toBeNull()
  expect(getCanvas(c.id)?.shared).toBe(false)
})

test('reaper clears only shares past their deadline', () => {
  const dead = createCanvas(P, { name: 'dead' })
  const live = createCanvas(P, { name: 'live' })
  const forever = createCanvas(P, { name: 'forever' })
  setCanvasShare(dead.id, 'r-dead', 'read', Date.now() - 1)
  setCanvasShare(live.id, 'r-live', 'read', Date.now() + 60_000)
  setCanvasShare(forever.id, 'r-forever', 'read')

  expect(reapExpiredCanvasShares()).toBe(1)
  expect(getCanvas(dead.id)?.shared).toBe(false)
  expect(getCanvas(dead.id)?.shareToken).toBeUndefined()
  expect(getCanvas(live.id)?.shared).toBe(true)
  expect(getCanvas(forever.id)?.shared).toBe(true)
  // Idempotent: nothing left to reap on a second pass.
  expect(reapExpiredCanvasShares()).toBe(0)
})

test('re-sharing after expiry mints a fresh token and the old one stays dead', () => {
  const c = createCanvas(P, { name: 'C' })
  setCanvasShare(c.id, 'old-token', 'read', Date.now() - 1)
  reapExpiredCanvasShares()
  setCanvasShare(c.id, 'new-token', 'edit', Date.now() + 60_000)

  expect(validateCanvasShare('old-token')).toBeNull()
  expect(validateCanvasShare('new-token')?.shareTier).toBe('edit')
})

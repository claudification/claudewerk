/**
 * resolveShareUpgrade -- the WS `?share=` seam between the two token namespaces.
 *
 * The security-relevant properties: a canvas guest gets NO grants (they are not
 * a project member), the socket is pinned to one canvas id + tier, and anything
 * unresolvable is rejected without saying why.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCanvasStore, createCanvas, initCanvasStore, setCanvasShare } from './canvas-store'
import { resolveShareUpgrade } from './share-upgrade'

const PROJECT = 'claude://default/Users/x/proj'
let dir: string
let canvasId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'share-upgrade-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C' }).id
})

afterEach(() => {
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

test('unknown token resolves to nothing', () => {
  expect(resolveShareUpgrade('no-such-token')).toBeNull()
  expect(resolveShareUpgrade('')).toBeNull()
})

test('canvas token pins the socket to that canvas at its tier', () => {
  setCanvasShare(canvasId, 'cnv-token', 'comment')
  const up = resolveShareUpgrade('cnv-token')
  expect(up).toMatchObject({
    isShare: true,
    shareToken: 'cnv-token',
    shareCanvasId: canvasId,
    shareCanvasTier: 'comment',
  })
})

test('a canvas guest carries no grants and no conversation scope', () => {
  setCanvasShare(canvasId, 'cnv-token', 'edit')
  const up = resolveShareUpgrade('cnv-token')
  expect(up?.grants).toEqual([])
  expect(up?.shareConversationId).toBeUndefined()
})

test('revoked canvas token stops resolving', () => {
  setCanvasShare(canvasId, 'cnv-token', 'read')
  setCanvasShare(canvasId, null, null)
  expect(resolveShareUpgrade('cnv-token')).toBeNull()
})

test('expired canvas token stops resolving', () => {
  setCanvasShare(canvasId, 'cnv-token', 'read', Date.now() - 1)
  expect(resolveShareUpgrade('cnv-token')).toBeNull()
})

test('tierless share defaults to read, never to write', () => {
  // Defensive: a row with a token but no tier must not be treated as editable.
  setCanvasShare(canvasId, 'cnv-token', null)
  const up = resolveShareUpgrade('cnv-token')
  expect(up?.shareCanvasTier).toBe('read')
})

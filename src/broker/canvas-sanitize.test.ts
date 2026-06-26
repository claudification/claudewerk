import { expect, test } from 'bun:test'
import { CANVAS_ANNOTATION_KEY, enforceCanvasTier, sanitizeCanvasScene } from './canvas-sanitize'

/** Build a scene JSON string from a list of elements. */
function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {} })
}

/** A base (design) element. */
function el(id: string, version = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'rectangle', version, x: 0, y: 0, ...extra }
}

/** An annotation element (guest comment). */
function annot(id: string, version = 1): Record<string, unknown> {
  return { id, type: 'text', version, text: 'note', customData: { [CANVAS_ANNOTATION_KEY]: true } }
}

// ─── sanitize (embeds + links) ───────────────────────────────────────
test('sanitize drops embeddable/iframe and unsafe links', () => {
  const dirty = scene([
    el('a'),
    { id: 'b', type: 'embeddable', link: 'https://evil.test' },
    { id: 'c', type: 'iframe' },
    el('d', 1, { link: 'javascript:alert(1)' }),
    el('e', 1, { link: 'https://ok.test' }),
  ])
  const r = sanitizeCanvasScene(dirty)
  expect(r.droppedElements).toBe(2)
  expect(r.strippedLinks).toBe(1)
  const parsed = JSON.parse(r.json as string)
  const ids = parsed.elements.map((x: { id: string }) => x.id)
  expect(ids).toEqual(['a', 'd', 'e'])
  expect(parsed.elements.find((x: { id: string }) => x.id === 'd').link).toBeNull()
  expect(parsed.elements.find((x: { id: string }) => x.id === 'e').link).toBe('https://ok.test')
})

test('sanitize rejects unparseable JSON', () => {
  expect(sanitizeCanvasScene('{not json').json).toBeNull()
})

// ─── tier: read ──────────────────────────────────────────────────────
test('read tier rejects any write', () => {
  const r = enforceCanvasTier(scene([el('a')]), scene([el('a'), annot('n1')]), 'read')
  expect(r.ok).toBe(false)
})

// ─── tier: edit ──────────────────────────────────────────────────────
test('edit tier accepts a base mutation but still sanitizes', () => {
  const next = scene([el('a', 2), { id: 'x', type: 'embeddable', link: 'https://evil.test' }])
  const r = enforceCanvasTier(scene([el('a')]), next, 'edit')
  expect(r.ok).toBe(true)
  const parsed = JSON.parse(r.json as string)
  expect(parsed.elements.map((x: { id: string }) => x.id)).toEqual(['a']) // embeddable dropped
})

// ─── tier: comment ───────────────────────────────────────────────────
test('comment tier accepts adding an annotation', () => {
  const r = enforceCanvasTier(scene([el('a'), el('b')]), scene([el('a'), el('b'), annot('n1')]), 'comment')
  expect(r.ok).toBe(true)
})

test('comment tier accepts modifying an existing annotation', () => {
  const r = enforceCanvasTier(scene([el('a'), annot('n1', 1)]), scene([el('a'), annot('n1', 2)]), 'comment')
  expect(r.ok).toBe(true)
})

test('comment tier rejects editing a base element (version bump)', () => {
  const r = enforceCanvasTier(scene([el('a', 1)]), scene([el('a', 2)]), 'comment')
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('base design')
})

test('comment tier rejects deleting a base element', () => {
  const r = enforceCanvasTier(scene([el('a'), el('b')]), scene([el('a')]), 'comment')
  expect(r.ok).toBe(false)
})

test('comment tier rejects adding a base element', () => {
  const r = enforceCanvasTier(scene([el('a')]), scene([el('a'), el('b')]), 'comment')
  expect(r.ok).toBe(false)
})

test('comment tier rejects an embeddable smuggled as an annotation-free base element', () => {
  const next = scene([el('a'), { id: 'x', type: 'embeddable' }])
  const r = enforceCanvasTier(scene([el('a')]), next, 'comment')
  // embeddable is sanitized out first, leaving base sig unchanged -> allowed,
  // and the dangerous element never persists.
  expect(r.ok).toBe(true)
  expect(JSON.parse(r.json as string).elements.map((x: { id: string }) => x.id)).toEqual(['a'])
})

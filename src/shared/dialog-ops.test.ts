import { describe, expect, test } from 'bun:test'
import type { DialogOp, DialogSnapshot } from './dialog-live'
import { applyDialogOps, validateDialogOps } from './dialog-ops'

function snap(overrides: Partial<DialogSnapshot> = {}): DialogSnapshot {
  return {
    dialogId: 'd1',
    seq: 3,
    status: 'open',
    state: { name: 'ada' },
    layout: {
      title: 'T',
      body: [
        { type: 'Markdown', id: 'intro', content: 'hi' },
        { type: 'Group', id: 'box', label: 'g', children: [{ type: 'Markdown', id: 'inner', content: 'x' }] },
      ],
    },
    ...overrides,
  } as DialogSnapshot
}

describe('validateDialogOps', () => {
  test('rejects non-array / empty', () => {
    expect(validateDialogOps('nope').length).toBeGreaterThan(0)
    expect(validateDialogOps([]).length).toBeGreaterThan(0)
  })

  test('accepts a well-formed op list', () => {
    const ops: DialogOp[] = [
      { op: 'replace', id: 'intro', block: { type: 'Markdown', id: 'intro', content: 'bye' } },
      { op: 'setState', key: 'name', value: 'grace' },
      { op: 'remove', id: 'inner' },
      { op: 'setPage', page: 1 },
      { op: 'setPage', page: 'Outlook' },
      { op: 'busy', pending: true },
      { op: 'close' },
    ]
    expect(validateDialogOps(ops)).toEqual([])
  })

  test('setPage rejects empty string / wrong type', () => {
    expect(validateDialogOps([{ op: 'setPage', page: '' }] as unknown).length).toBe(1)
    expect(validateDialogOps([{ op: 'setPage' }] as unknown).length).toBe(1)
    expect(validateDialogOps([{ op: 'setPage', page: true }] as unknown).length).toBe(1)
  })

  test('flags missing fields + unknown op + after/into clash', () => {
    const errs = validateDialogOps([
      { op: 'replace', block: { type: 'Markdown' } },
      { op: 'append', block: { type: 'Markdown' }, after: 'a', into: 'b' },
      { op: 'setState' },
      { op: 'busy' },
      { op: 'frobnicate' },
    ] as unknown)
    expect(errs.length).toBe(5)
  })
})

describe('applyDialogOps', () => {
  test('does not mutate the input snapshot', () => {
    const s = snap()
    applyDialogOps(s, [{ op: 'replace', id: 'intro', block: { type: 'Markdown', id: 'intro', content: 'new' } }])
    expect((s.layout.body?.[0] as { content: string }).content).toBe('hi')
    expect(s.state.name).toBe('ada')
  })

  test('replace / remove / append (root + nested + into)', () => {
    const r = applyDialogOps(snap(), [
      { op: 'replace', id: 'intro', block: { type: 'Markdown', id: 'intro', content: 'new' } },
      { op: 'append', after: 'intro', block: { type: 'Divider', id: 'd' } },
      { op: 'append', into: 'box', block: { type: 'Markdown', id: 'inner2', content: 'y' } },
      { op: 'remove', id: 'inner' },
    ])
    expect(r.applied).toBe(4)
    expect(r.conflicts).toEqual([])
    const body = r.layout.body as Array<{ type: string; id: string; children?: unknown[] }>
    expect(body.map(b => b.id)).toEqual(['intro', 'd', 'box'])
    expect((body[0] as unknown as { content: string }).content).toBe('new')
    const box = body[2]
    expect((box.children as Array<{ id: string }>).map(c => c.id)).toEqual(['inner2'])
  })

  test('missing target ids become conflicts, not silent drops', () => {
    const r = applyDialogOps(snap(), [
      { op: 'replace', id: 'ghost', block: { type: 'Markdown', id: 'ghost', content: 'z' } },
      { op: 'append', into: 'nope', block: { type: 'Divider', id: 'd' } },
    ])
    expect(r.applied).toBe(0)
    expect(r.conflicts.length).toBe(2)
  })

  test('setState compare-and-swap: applies on match, conflicts on mismatch', () => {
    const ok = applyDialogOps(snap(), [{ op: 'setState', key: 'name', value: 'grace', expect: 'ada' }])
    expect(ok.state.name).toBe('grace')
    expect(ok.conflicts).toEqual([])

    const bad = applyDialogOps(snap(), [{ op: 'setState', key: 'name', value: 'grace', expect: 'lin' }])
    expect(bad.state.name).toBe('ada')
    expect(bad.conflicts.length).toBe(1)
  })

  test('setPage parks focus in the reserved _activePage state key', () => {
    const byIndex = applyDialogOps(snap(), [{ op: 'setPage', page: 2 }])
    expect(byIndex.state._activePage).toBe(2)
    expect(byIndex.applied).toBe(1)
    expect(byIndex.conflicts).toEqual([])

    const byLabel = applyDialogOps(snap(), [{ op: 'setPage', page: 'Outlook' }])
    expect(byLabel.state._activePage).toBe('Outlook')
  })

  test('unsetState removes key; close flips status', () => {
    const r = applyDialogOps(snap(), [{ op: 'unsetState', key: 'name' }, { op: 'close' }])
    expect('name' in r.state).toBe(false)
    expect(r.status).toBe('closed')
  })
})

// ─── Page-level ops ─────────────────────────────────────────────────

function pageSnap(): DialogSnapshot {
  return {
    dialogId: 'd1',
    seq: 0,
    status: 'open',
    state: {},
    layout: {
      title: 'Tabbed',
      pages: [
        { label: 'Plan', body: [{ type: 'Markdown', id: 'p1', content: 'plan' }] },
        { label: 'Files', body: [{ type: 'Markdown', id: 'p2', content: 'files' }] },
        { label: 'Risks', body: [{ type: 'Markdown', id: 'p3', content: 'risks' }] },
      ],
    },
  } as DialogSnapshot
}

describe('page-level ops', () => {
  test('addPage appends at end by default', () => {
    const r = applyDialogOps(pageSnap(), [
      { op: 'addPage', label: 'Notes', body: [{ type: 'Markdown', id: 'n1', content: 'notes' }] },
    ])
    expect(r.layout.pages).toHaveLength(4)
    expect(r.layout.pages![3].label).toBe('Notes')
    expect(r.applied).toBe(1)
  })

  test('addPage inserts after target by index', () => {
    const r = applyDialogOps(pageSnap(), [
      { op: 'addPage', label: 'Schema', body: [], after: 0 },
    ])
    expect(r.layout.pages).toHaveLength(4)
    expect(r.layout.pages![1].label).toBe('Schema')
    expect(r.layout.pages![2].label).toBe('Files')
  })

  test('addPage inserts after target by label', () => {
    const r = applyDialogOps(pageSnap(), [
      { op: 'addPage', label: 'Schema', body: [], after: 'Files' },
    ])
    expect(r.layout.pages![2].label).toBe('Schema')
    expect(r.layout.pages![3].label).toBe('Risks')
  })

  test('removePage by index', () => {
    const r = applyDialogOps(pageSnap(), [{ op: 'removePage', page: 1 }])
    expect(r.layout.pages).toHaveLength(2)
    expect(r.layout.pages![0].label).toBe('Plan')
    expect(r.layout.pages![1].label).toBe('Risks')
  })

  test('removePage by label (case-insensitive)', () => {
    const r = applyDialogOps(pageSnap(), [{ op: 'removePage', page: 'risks' }])
    expect(r.layout.pages).toHaveLength(2)
    expect(r.applied).toBe(1)
  })

  test('removePage rejects last page', () => {
    const single = { ...pageSnap(), layout: { title: 'T', pages: [{ label: 'Only', body: [] }] } } as DialogSnapshot
    const r = applyDialogOps(single, [{ op: 'removePage', page: 0 }])
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toContain('cannot remove the last page')
  })

  test('removePage conflicts on missing page', () => {
    const r = applyDialogOps(pageSnap(), [{ op: 'removePage', page: 'nonexistent' }])
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toContain('not found')
  })

  test('replacePage updates label and body', () => {
    const r = applyDialogOps(pageSnap(), [
      { op: 'replacePage', page: 'Files', label: 'Changed Files', body: [{ type: 'Markdown', id: 'new', content: 'new' }] },
    ])
    expect(r.layout.pages![1].label).toBe('Changed Files')
    expect(r.layout.pages![1].body).toHaveLength(1)
    expect((r.layout.pages![1].body[0] as { id: string }).id).toBe('new')
  })

  test('replacePage updates only label when body omitted', () => {
    const r = applyDialogOps(pageSnap(), [{ op: 'replacePage', page: 0, label: 'Overview' }])
    expect(r.layout.pages![0].label).toBe('Overview')
    expect(r.layout.pages![0].body).toHaveLength(1)
  })

  test('page ops conflict on body-only layout', () => {
    const r = applyDialogOps(snap(), [{ op: 'addPage', label: 'X', body: [] }])
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].reason).toContain('no pages')
  })

  test('validates page op shapes', () => {
    const errs = validateDialogOps([
      { op: 'addPage' },
      { op: 'removePage' },
      { op: 'replacePage', page: 0, label: 42 },
    ])
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.some(e => e.includes('label'))).toBe(true)
    expect(errs.some(e => e.includes('body'))).toBe(true)
  })
})

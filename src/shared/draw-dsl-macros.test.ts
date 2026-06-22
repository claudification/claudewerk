/**
 * Phase-3 coverage: semantic-UI macro skeletons, layout-container edge cases, and the
 * mermaid node SEAM (pure half -- placement + reverse round-trip). The actual mermaid
 * parse runs through a DOM-bound runtime (parseMermaidToExcalidraw needs `document`), so
 * it is exercised by typecheck + build:web, not here; this file pins everything pure.
 */
import { describe, expect, it } from 'bun:test'
import type { Scene, Skeleton } from './draw-dsl'
import { expandScene } from './draw-dsl-expand'
import { type RawElement, reverseScene } from './draw-dsl-reverse'

const byId = (sks: Skeleton[], id: string) => sks.find(s => s.id === id)
const ACCENT = '#1971c2'

describe('UI macros -> sketchy wireframe skeletons', () => {
  it('button: a rounded rect with a bound label; primary fills accent', () => {
    const { skeletons } = expandScene({ v: 1, nodes: [{ id: 'b', kind: 'button', text: 'Save', variant: 'primary' }] })
    const b = byId(skeletons, 'b')
    expect(b?.type).toBe('rectangle')
    expect(b?.backgroundColor).toBe(ACCENT)
    expect(b?.label?.text).toBe('Save')
  })

  it('input: optional label text + a rounded field carrying the placeholder', () => {
    const { skeletons } = expandScene({
      v: 1,
      nodes: [{ id: 'in', kind: 'input', label: 'Email', placeholder: 'you@x.com' }],
    })
    expect(byId(skeletons, 'in~lbl')?.text).toBe('Email')
    expect(byId(skeletons, 'in')?.label?.text).toBe('you@x.com')
  })

  it('checkbox: box fills when checked + a side label', () => {
    const { skeletons } = expandScene({ v: 1, nodes: [{ id: 'c', kind: 'checkbox', text: 'Agree', checked: true }] })
    expect(byId(skeletons, 'c')?.backgroundColor).toBe(ACCENT)
    expect(byId(skeletons, 'c~lbl')?.text).toBe('Agree')
  })

  it('nav: a bar with the items joined into one label', () => {
    const { skeletons } = expandScene({ v: 1, nodes: [{ id: 'n', kind: 'nav', items: ['Home', 'Docs'] }] })
    expect(byId(skeletons, 'n')?.type).toBe('rectangle')
    expect(byId(skeletons, 'n~items')?.text).toContain('Home')
    expect(byId(skeletons, 'n~items')?.text).toContain('Docs')
  })

  it('image: dashed frame + a diagonal cross + a bottom caption (the wireframe placeholder)', () => {
    const { skeletons } = expandScene({ v: 1, nodes: [{ id: 'img', kind: 'image', url: 'https://x.com/cat.png' }] })
    expect(byId(skeletons, 'img')?.strokeStyle).toBe('dashed')
    expect(skeletons.filter(s => s.type === 'line')).toHaveLength(2)
    expect(byId(skeletons, 'img~cap')?.text).toBe('cat.png')
  })

  it('card: a named frame whose children are listed as frame members', () => {
    const { skeletons } = expandScene({
      v: 1,
      nodes: [
        { id: 'card1', kind: 'card', title: 'Profile', children: [{ id: 'edit', kind: 'button', text: 'Edit' }] },
      ],
    })
    const frame = byId(skeletons, 'card1')
    expect(frame?.type).toBe('frame')
    expect(frame?.name).toBe('Profile')
    expect(frame?.children).toContain('edit')
  })
})

describe('layout containers -- placement + edge cases', () => {
  it('grid: row-major positions at the column/row pitch', () => {
    const cell = (n: number) => ({ id: `g${n}`, kind: 'box' as const, text: `${n}`, w: 100, h: 50 })
    const { skeletons } = expandScene({
      v: 1,
      nodes: [{ kind: 'grid', cols: 2, gap: 10, children: [cell(0), cell(1), cell(2), cell(3)] }],
    })
    const g0 = byId(skeletons, 'g0')
    const g1 = byId(skeletons, 'g1')
    const g2 = byId(skeletons, 'g2')
    expect(g1?.x).toBe((g0?.x ?? 0) + 110) // next column
    expect(g2?.y).toBe((g0?.y ?? 0) + 60) // next row
  })

  it('row align=center vertically centres a short child against a tall one', () => {
    const { skeletons } = expandScene({
      v: 1,
      nodes: [
        {
          kind: 'row',
          align: 'center',
          children: [
            { id: 'tall', kind: 'box', text: 'T', h: 120 },
            { id: 'short', kind: 'box', text: 'S', h: 40 },
          ],
        },
      ],
    })
    expect(byId(skeletons, 'short')?.y).toBe((byId(skeletons, 'tall')?.y ?? 0) + 40) // (120-40)/2
  })

  it('nested row inside col places both axes without collision', () => {
    const { skeletons } = expandScene({
      v: 1,
      nodes: [
        {
          kind: 'col',
          children: [
            { id: 'top', kind: 'box', text: 'top' },
            {
              kind: 'row',
              children: [
                { id: 'l', kind: 'box', text: 'l' },
                { id: 'r', kind: 'box', text: 'r' },
              ],
            },
          ],
        },
      ],
    })
    expect(byId(skeletons, 'r')?.x).toBeGreaterThan(byId(skeletons, 'l')?.x ?? 0)
    expect(byId(skeletons, 'l')?.y).toBeGreaterThan(byId(skeletons, 'top')?.y ?? 0)
  })

  it('empty containers expand to nothing without throwing', () => {
    expect(() => expandScene({ v: 1, nodes: [{ kind: 'col', children: [] }] }).skeletons).not.toThrow()
    expect(() => expandScene({ v: 1, nodes: [{ kind: 'grid', cols: 3, children: [] }] }).skeletons).not.toThrow()
  })
})

describe('mermaid node -- pure seam', () => {
  const def = 'graph TD; A-->B'

  it('reserves a placement box (no sync skeleton) so neighbours lay out around it', () => {
    const scene: Scene = {
      v: 1,
      nodes: [
        { id: 'm', kind: 'mermaid', def },
        { id: 'after', kind: 'box', text: 'x' },
      ],
    }
    const { skeletons, mermaids } = expandScene(scene)
    expect(mermaids).toHaveLength(1)
    expect(mermaids[0]).toMatchObject({ id: 'm', def, x: 0, y: 0, w: 360, h: 260 })
    expect(byId(skeletons, 'm')).toBeUndefined() // mermaid emits no element in the pure pass
    expect(byId(skeletons, 'after')?.y).toBe(284) // 260 (reserved) + 24 (gap)
  })

  it('honours the agent size hint', () => {
    const { mermaids } = expandScene({ v: 1, nodes: [{ id: 'm', kind: 'mermaid', def, w: 500, h: 400 }] })
    expect(mermaids[0]).toMatchObject({ w: 500, h: 400 })
  })

  it('reverse: a mermaid subgraph round-trips to one node (def preserved) + annotations stay distinct', () => {
    const base: Scene = { v: 1, nodes: [{ id: 'm', kind: 'mermaid', def }] }
    const el = (p: Partial<RawElement> & { id: string; type: string }): RawElement => p
    const mz = { dslId: 'm', role: 'agent', data: { mermaid: true } }
    const elements: RawElement[] = [
      el({ id: 'mm-A', type: 'rectangle', x: 100, y: 100, width: 80, height: 40, customData: mz }),
      el({ id: 'mm-B', type: 'rectangle', x: 100, y: 200, width: 80, height: 40, customData: mz }),
      el({ id: 'mm-arrow', type: 'arrow', x: 140, y: 140, width: 0, height: 60, customData: mz }),
      el({ id: 'note', type: 'text', x: 400, y: 400, width: 60, height: 20, text: 'fix B' }), // annotation
    ]
    const { scene, diff } = reverseScene(elements, base)
    const m = scene.nodes.find(n => 'id' in n && n.id === 'm') as { kind: string; def: string; at: number[] }
    expect(m.kind).toBe('mermaid')
    expect(m.def).toBe(def) // preserved verbatim
    expect(m.at).toEqual([100, 100]) // union-box top-left, not a single sub-shape
    expect(diff.removed).toHaveLength(0) // the subgraph is not seen as a deletion
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].text).toBe('fix B')
  })
})

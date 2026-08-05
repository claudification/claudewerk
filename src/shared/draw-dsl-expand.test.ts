import { describe, expect, it } from 'bun:test'
import type { Scene, Skeleton } from './draw-dsl'
import { isDslScene } from './draw-dsl'
import { expandScene } from './draw-dsl-expand'
import { FONT_FAMILY } from './scheme-variants'

const byId = (sks: Skeleton[], id: string) => sks.find(s => s.id === id)

describe('isDslScene', () => {
  it('accepts a v:1 scene with nodes, rejects a raw Excalidraw scene', () => {
    expect(isDslScene({ v: 1, nodes: [] })).toBe(true)
    expect(isDslScene({ elements: [], appState: {} })).toBe(false)
    expect(isDslScene(null)).toBe(false)
    expect(isDslScene('x')).toBe(false)
  })
})

describe('expandScene -- flowchart (auto layout + bound arrows)', () => {
  const scene: Scene = {
    v: 1,
    nodes: [
      { id: 'a', kind: 'box', text: 'User request' },
      { id: 'b', kind: 'diamond', text: 'Auth?' },
      { id: 'c', kind: 'box', text: 'Serve' },
      { id: 'd', kind: 'box', text: '401' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', text: 'yes' },
      { from: 'b', to: 'd', text: 'no' },
    ],
  }
  const { skeletons, metaById } = expandScene(scene)

  it('maps each node to a skeleton with its dsl id preserved', () => {
    expect(byId(skeletons, 'a')?.type).toBe('rectangle')
    expect(byId(skeletons, 'b')?.type).toBe('diamond')
    expect(metaById.a.dslId).toBe('a')
    expect(metaById.a.role).toBe('agent')
  })

  it('layers nodes top-down by edge rank', () => {
    const a = byId(skeletons, 'a') as Skeleton
    const b = byId(skeletons, 'b') as Skeleton
    const c = byId(skeletons, 'c') as Skeleton
    const d = byId(skeletons, 'd') as Skeleton
    expect((b.y ?? 0) > (a.y ?? 0)).toBe(true)
    expect((c.y ?? 0) > (b.y ?? 0)).toBe(true)
    expect(c.y).toBe(d.y) // siblings share a rank
  })

  it('emits explicitly routed arrows, one per edge', () => {
    const arrows = skeletons.filter(s => s.type === 'arrow')
    expect(arrows).toHaveLength(3)
    const ab = byId(skeletons, 'a~edge~b')
    // explicit orthogonal points, not the unrouted convert stub
    expect((ab?.points?.length ?? 0) >= 2).toBe(true)
    expect(byId(skeletons, 'b~edge~c')).toBeDefined()
  })

  // A bound arrow is re-anchored to both elements' CENTRES, so it renders straight
  // through the boxes. We route it ourselves instead -- see draw-dsl-edges.ts.
  it('does NOT bind a routed arrow to its endpoints', () => {
    for (const a of skeletons.filter(s => s.type === 'arrow')) {
      expect(a.start).toBeUndefined()
      expect(a.end).toBeUndefined()
    }
  })

  it('keeps every arrow endpoint outside both boxes it joins', () => {
    const rect = (id: string) => {
      const s = byId(skeletons, id) as Skeleton
      return { x: s.x ?? 0, y: s.y ?? 0, w: s.width ?? 0, h: s.height ?? 0 }
    }
    const inside = (r: ReturnType<typeof rect>, x: number, y: number) =>
      x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h
    for (const [edgeId, from, to] of [
      ['a~edge~b', 'a', 'b'],
      ['b~edge~c', 'b', 'c'],
      ['b~edge~d', 'b', 'd'],
    ]) {
      const a = byId(skeletons, edgeId) as Skeleton
      for (const [px, py] of a.points ?? []) {
        const x = (a.x ?? 0) + px
        const y = (a.y ?? 0) + py
        expect(inside(rect(from), x, y)).toBe(false)
        expect(inside(rect(to), x, y)).toBe(false)
      }
    }
  })

  it('binds an edge label ON the connector, in the hand-drawn font', () => {
    const arrow = byId(skeletons, 'b~edge~c')
    expect(arrow?.type).toBe('arrow')
    expect(arrow?.label?.text).toBe('yes')
    expect(arrow?.label?.fontFamily).toBe(FONT_FAMILY.excalifont)
  })

  it('never emits a free chip on top of a connector -- a dragged box would strand it', () => {
    expect(skeletons.some(s => s.id?.includes('~pill'))).toBe(false)
    // one skeleton per edge, label included: nothing to leave behind
    expect(skeletons.filter(s => s.type === 'arrow')).toHaveLength(3)
    expect(metaById['b~edge~c'].dslId).toBe('b~edge~c')
  })

  it('leaves an unlabelled edge label-free', () => {
    expect(byId(skeletons, 'a~edge~b')?.label).toBeUndefined()
  })
})

describe('expandScene -- UI wireframe (no pixel math)', () => {
  const scene: Scene = {
    v: 1,
    nodes: [
      {
        id: 'login',
        kind: 'screen',
        title: 'Sign in',
        w: 360,
        children: [
          {
            kind: 'col',
            gap: 16,
            children: [
              { id: 'email', kind: 'input', label: 'Email', placeholder: 'you@co.com' },
              { id: 'pw', kind: 'input', label: 'Password', placeholder: '********' },
              { id: 'remember', kind: 'checkbox', text: 'Remember me' },
              { id: 'go', kind: 'button', text: 'Sign in', variant: 'primary' },
            ],
          },
        ],
      },
    ],
  }
  const { skeletons } = expandScene(scene)

  it('wraps children in a named frame', () => {
    const frame = byId(skeletons, 'login') as Skeleton
    expect(frame.type).toBe('frame')
    expect(frame.name).toBe('Sign in')
    expect(frame.children).toContain('email')
    expect(frame.children).toContain('go')
  })

  it('stacks the column children with increasing y', () => {
    const email = byId(skeletons, 'email') as Skeleton
    const pw = byId(skeletons, 'pw') as Skeleton
    const go = byId(skeletons, 'go') as Skeleton
    expect((pw.y ?? 0) > (email.y ?? 0)).toBe(true)
    expect((go.y ?? 0) > (pw.y ?? 0)).toBe(true)
  })

  it('renders a filled primary button', () => {
    const go = byId(skeletons, 'go') as Skeleton
    expect(go.backgroundColor).toBe('#1971c2')
    expect(go.label?.text).toBe('Sign in')
  })
})

describe('expandScene -- free layout', () => {
  it('honours explicit `at` coordinates', () => {
    const { skeletons } = expandScene({
      v: 1,
      layout: 'free',
      nodes: [
        { id: 'x', kind: 'box', text: 'X', at: [300, 120] },
        { id: 'y', kind: 'box', text: 'Y', at: [10, 10] },
      ],
    })
    expect(byId(skeletons, 'x')).toMatchObject({ x: 300, y: 120 })
    expect(byId(skeletons, 'y')).toMatchObject({ x: 10, y: 10 })
  })
})

describe('expandScene -- diagram-as-data', () => {
  it('carries node.data through to customData meta', () => {
    const scene: Scene = {
      v: 1,
      nodes: [
        {
          kind: 'row',
          gap: 40,
          children: [
            {
              id: 'todo',
              kind: 'card',
              title: 'Todo',
              children: [
                {
                  id: 't1',
                  kind: 'box',
                  text: 'Fix daemon socket',
                  data: { taskId: 'bug-daemon-socket', prio: 'high' },
                },
              ],
            },
          ],
        },
      ],
    }
    const { metaById } = expandScene(scene)
    expect(metaById.t1.data).toEqual({ taskId: 'bug-daemon-socket', prio: 'high' })
  })
})

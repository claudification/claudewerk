import { describe, expect, it } from 'bun:test'
import type { Scene, Skeleton } from './draw-dsl'
import { expandScene } from './draw-dsl-expand'
import { type RawElement, reverseScene } from './draw-dsl-reverse'
import { SCHEME_FILLS, SCHEME_RECIPE } from './scheme-variants'

const byId = (sks: Skeleton[], id: string): Skeleton | undefined => sks.find(s => s.id === id)

describe('scheme box -- variant + title + subtitle', () => {
  const scene: Scene = {
    v: 1,
    layout: 'flow',
    nodes: [
      { id: 'a', kind: 'box', title: 'GATE SIGN', subtitle: 'send - sign - seal', variant: 'blue' },
      { id: 'b', kind: 'box', title: 'Signer 1', subtitle: 'own link', variant: 'gold' },
    ],
    edges: [{ from: 'a', to: 'b', text: '1. Create' }],
  }
  const { skeletons, metaById } = expandScene(scene)

  it('emits a pastel rectangle with the variant fill + sketch recipe', () => {
    const rect = byId(skeletons, 'a') as Skeleton
    expect(rect.type).toBe('rectangle')
    expect(rect.backgroundColor).toBe(SCHEME_FILLS.blue)
    expect(rect.strokeColor).toBe(SCHEME_RECIPE.stroke)
    expect(rect.roughness).toBe(SCHEME_RECIPE.roughness)
    expect(rect.roundness).toEqual({ type: SCHEME_RECIPE.roundnessType })
  })

  it('emits an ink title + grey subtitle, both riding the box dslId', () => {
    const title = byId(skeletons, 'a~title') as Skeleton
    expect(title.text).toBe('GATE SIGN')
    expect(title.fontSize).toBe(SCHEME_RECIPE.titlePx)
    expect(title.fontFamily).toBe(SCHEME_RECIPE.titleFont)
    expect(title.strokeColor).toBe(SCHEME_RECIPE.titleColor)

    const sub = byId(skeletons, 'a~sub') as Skeleton
    expect(sub.text).toBe('send - sign - seal')
    expect(sub.strokeColor).toBe(SCHEME_RECIPE.subColor)

    expect(metaById['a~title'].dslId).toBe('a')
    expect(metaById['a~sub'].dslId).toBe('a')
  })

  it('sizes the box generously so the longest line fits with padding', () => {
    const rect = byId(skeletons, 'a') as Skeleton
    const longest = 'send - sign - seal'.length * SCHEME_RECIPE.subPx * SCHEME_RECIPE.glyphW
    expect((rect.width ?? 0) >= longest).toBe(true)
  })

  it('round-trips with NO spurious diff when the user changed nothing', () => {
    // Faithfully model convert's output: bare `text` on a shape is dropped (it survives only
    // as the reverse pass's baseline label); text elements keep their text.
    const live: RawElement[] = skeletons.map(sk => ({
      id: sk.id as string,
      type: sk.type,
      x: sk.x,
      y: sk.y,
      width: sk.width,
      height: sk.height,
      text: sk.type === 'text' ? sk.text : undefined,
      customData: { dslId: metaById[sk.id as string]?.dslId },
    }))
    const { diff, scene: out } = reverseScene(live, scene)
    expect(diff.moved).toHaveLength(0)
    expect(diff.resized).toHaveLength(0)
    expect(diff.relabeled).toHaveLength(0)
    expect(diff.added).toHaveLength(0)
    expect(out.nodes.map(n => ('id' in n ? n.id : undefined)).sort()).toEqual(['a', 'b'])
  })
})

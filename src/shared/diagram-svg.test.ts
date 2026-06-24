import { describe, expect, it } from 'bun:test'
import { PALETTES } from './diagram-palette'
import { sceneToSvg } from './diagram-svg'
import type { Scene } from './draw-dsl'

const scene: Scene = {
  v: 1,
  layout: 'flow',
  nodes: [
    { id: 'a', kind: 'box', title: 'Alpha', subtitle: 'one', variant: 'blue' },
    { id: 'b', kind: 'box', title: 'Beta', subtitle: 'two', variant: 'gold' },
  ],
  edges: [{ from: 'a', to: 'b', text: 'go' }],
}

describe('sceneToSvg', () => {
  const light = sceneToSvg(scene, 'light')

  it('emits a standalone svg painted with the theme background', () => {
    expect(light.startsWith('<svg')).toBe(true)
    expect(light.endsWith('</svg>')).toBe(true)
    expect(light).toContain(`fill="${PALETTES.light.bg}"`)
  })

  it('centers every label with text-anchor=middle (no glyph estimate)', () => {
    const texts = light.match(/<text[^>]*>/g) ?? []
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every(t => t.includes('text-anchor="middle"'))).toBe(true)
  })

  it('renders title, subtitle and the on-line pill label', () => {
    expect(light).toContain('>Alpha<')
    expect(light).toContain('>one<')
    expect(light).toContain('>go<')
  })

  it('paints variant fills straight from the palette', () => {
    expect(light).toContain(`fill="${PALETTES.light.variants.blue.fill}"`)
    expect(light).toContain(`fill="${PALETTES.light.variants.gold.fill}"`)
  })

  it('dark theme uses the hand-authored dark palette, never the light one', () => {
    const dark = sceneToSvg(scene, 'dark')
    expect(dark).toContain(`fill="${PALETTES.dark.bg}"`)
    expect(dark).toContain(`fill="${PALETTES.dark.variants.blue.fill}"`)
    expect(dark).not.toContain(`fill="${PALETTES.light.bg}"`)
  })

  it('escapes special characters in labels', () => {
    const s = sceneToSvg({ v: 1, nodes: [{ id: 'x', kind: 'box', title: 'A & B <c>' }] })
    expect(s).toContain('A &amp; B &lt;c&gt;')
  })
})

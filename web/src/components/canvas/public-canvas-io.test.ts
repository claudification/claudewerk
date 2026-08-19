/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { sceneElementIds, tagAnnotations } from './public-canvas-io'

const ANNOTATION_KEY = 'canvasAnnotation'

function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', elements })
}

describe('sceneElementIds', () => {
  it('collects element ids', () => {
    expect(sceneElementIds(scene([{ id: 'a' }, { id: 'b' }]))).toEqual(new Set(['a', 'b']))
  })
  it('returns empty for null/garbage', () => {
    expect(sceneElementIds(null).size).toBe(0)
    expect(sceneElementIds('{bad').size).toBe(0)
  })
})

describe('tagAnnotations', () => {
  it('tags only elements not in the base set', () => {
    const base = new Set(['a'])
    const out = JSON.parse(tagAnnotations(scene([{ id: 'a' }, { id: 'b' }]), base))
    const a = out.elements.find((e: { id: string }) => e.id === 'a')
    const b = out.elements.find((e: { id: string }) => e.id === 'b')
    expect(a.customData?.[ANNOTATION_KEY]).toBeUndefined()
    expect(b.customData?.[ANNOTATION_KEY]).toBe(true)
  })
  it('preserves existing customData when tagging', () => {
    const out = JSON.parse(tagAnnotations(scene([{ id: 'n', customData: { foo: 1 } }]), new Set()))
    expect(out.elements[0].customData).toEqual({ foo: 1, [ANNOTATION_KEY]: true })
  })
  it('returns input unchanged on parse failure', () => {
    expect(tagAnnotations('{bad', new Set())).toBe('{bad')
  })
})

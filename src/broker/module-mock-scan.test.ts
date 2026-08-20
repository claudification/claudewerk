/**
 * The completeness guard is only as good as the parser under it, so the parser
 * gets its own tests. Every fixture here lives inside a template literal, which
 * `maskNonCode` blanks -- that is also why this file does not trip the guard it
 * feeds.
 */

import { describe, expect, test } from 'bun:test'
import { findModuleMockCalls, maskNonCode, valueExportsOf } from './module-mock-scan'

describe('maskNonCode', () => {
  test('blanks comments, strings and regex literals but keeps offsets', () => {
    const src = `const a = 'xx' // yy\nconst re = /zz/\n`
    const masked = maskNonCode(src)
    expect(masked.length).toBe(src.length)
    expect(masked.split('\n').length).toBe(src.split('\n').length)
    expect(masked).not.toContain('xx')
    expect(masked).not.toContain('yy')
    expect(masked).not.toContain('zz')
    expect(masked).toContain('const a =')
  })

  test('a division is not mistaken for a regex', () => {
    const masked = maskNonCode(`const half = total / 2\nconst rest = other / 3\n`)
    expect(masked).toContain('total / 2')
    expect(masked).toContain('other / 3')
  })
})

describe('findModuleMockCalls', () => {
  test('reads the specifier and the factory keys', () => {
    const calls = findModuleMockCalls(`mock.module('./push', () => ({ isPushConfigured, sendPushToAll }))`)
    expect(calls).toHaveLength(1)
    expect(calls[0].specifier).toBe('./push')
    expect(calls[0].keys).toEqual(['isPushConfigured', 'sendPushToAll'])
    expect(calls[0].opaque).toBe(false)
    expect(calls[0].line).toBe(1)
  })

  test('handles method shorthand, async methods and quoted keys', () => {
    const calls = findModuleMockCalls(
      `mock.module('./x', () => ({\n  a: 1,\n  async b() { return { nested: 1 } },\n  get c() { return 2 },\n  'd': 3,\n}))`,
    )
    expect(calls[0].keys).toEqual(['a', 'b', 'c', 'd'])
  })

  test('a block-bodied factory that returns an object is read the same way', () => {
    const calls = findModuleMockCalls(`mock.module('./x', () => {\n  return { a, b }\n})`)
    expect(calls[0].keys).toEqual(['a', 'b'])
  })

  test('a spread or a computed key marks the factory opaque', () => {
    expect(findModuleMockCalls(`mock.module('./x', () => ({ ...real, a: 1 }))`)[0].opaque).toBe(true)
    expect(findModuleMockCalls(`mock.module('./x', () => ({ [k]: 1 }))`)[0].opaque).toBe(true)
  })

  test('nested object values do not leak into the top-level key list', () => {
    const calls = findModuleMockCalls(`mock.module('./x', () => ({ a: { inner: 1, other: 2 }, b: [1, 2] }))`)
    expect(calls[0].keys).toEqual(['a', 'b'])
  })

  test('a call quoted inside a comment or a regex is not a call', () => {
    const src = `// mock.module('./x', () => ({}))\nconst re = /mock\\.module\\(/\nconst s = "mock.module('./y', () => ({}))"\n`
    expect(findModuleMockCalls(src)).toEqual([])
  })

  test('an unreadable factory shape throws instead of passing quietly', () => {
    expect(() => findModuleMockCalls(`mock.module('./x', factoryFromElsewhere)`, 'f.ts')).toThrow(/cannot audit/)
    expect(() => findModuleMockCalls(`mock.module(specVariable, () => ({}))`, 'f.ts')).toThrow(/not a literal string/)
  })
})

describe('valueExportsOf', () => {
  test('lists value exports and elides type-only ones', () => {
    const exports = valueExportsOf(
      `export type Foo = string\nexport interface Bar { a: 1 }\nexport type { Foo as Baz }\nexport const one = 1\nexport function two() {}\nexport { one as three }\n`,
    )
    expect(exports.sort()).toEqual(['one', 'three', 'two'])
  })
})

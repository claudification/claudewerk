import { describe, expect, test } from 'bun:test'
import { scanString, scanTopLevelEntries, scanValue, skipWs, splitElements } from './json-scan'

describe('scanTopLevelEntries', () => {
  test('reads a well-formed object', () => {
    const m = scanTopLevelEntries('{"a":[1,2],"b":"x","c":{"d":1}}')
    expect([...m]).toEqual([
      ['a', '[1,2]'],
      ['b', '"x"'],
      ['c', '{"d":1}'],
    ])
  })

  test('ignores keys nested inside a value', () => {
    const m = scanTopLevelEntries('{"a":[{"nested":1}],"b":2}')
    expect([...m.keys()]).toEqual(['a', 'b'])
  })

  test('keeps reading past a malformed value', () => {
    // The incident shape: a stray key inside an array.
    const m = scanTopLevelEntries('{"a":["x","k":["y"]],"b":["z"]}')
    expect(m.get('a')).toBe('["x","k":["y"]]')
    expect(m.get('b')).toBe('["z"]')
  })

  test('a truncated final value is returned as the partial text it is', () => {
    const m = scanTopLevelEntries('{"a":[1],"b":["unclo')
    expect(m.get('a')).toBe('[1]')
    expect(m.get('b')).toBe('["unclo')
  })

  test('first occurrence of a duplicate key wins', () => {
    expect(scanTopLevelEntries('{"a":[1],"a":[2]}').get('a')).toBe('[1]')
  })

  test('tolerates prose before the object', () => {
    expect(scanTopLevelEntries('Sure! Here is the JSON:\n{"a":[1]}').get('a')).toBe('[1]')
  })

  test('no object at all yields nothing', () => {
    expect(scanTopLevelEntries('nope').size).toBe(0)
    expect(scanTopLevelEntries('').size).toBe(0)
  })

  test('an unterminated key stops the scan cleanly', () => {
    expect([...scanTopLevelEntries('{"a":[1],"unterminated').keys()]).toEqual(['a'])
  })

  test('a separator inside a string is data, not syntax', () => {
    const m = scanTopLevelEntries('{"a":"x:y,z}","b":[1]}')
    expect(m.get('a')).toBe('"x:y,z}"')
    expect(m.get('b')).toBe('[1]')
  })
})

describe('splitElements', () => {
  test('splits mixed element types', () => {
    expect(splitElements('["a",{"t":1},[2],3]')).toEqual(['"a"', '{"t":1}', '[2]', '3'])
  })

  test('does not split on a comma inside a string or a nested structure', () => {
    expect(splitElements('["a,b",{"t":"c,d"}]')).toEqual(['"a,b"', '{"t":"c,d"}'])
  })

  test('returns a truncated tail element rather than dropping it silently', () => {
    expect(splitElements('["a","bc')).toEqual(['"a"', '"bc'])
  })

  test('empty array', () => {
    expect(splitElements('[]')).toEqual([])
  })
})

describe('scanString / scanValue / skipWs', () => {
  test('escape-aware string scan', () => {
    const raw = '"he said \\"no\\"" rest'
    expect(raw.slice(0, scanString(raw, 0))).toBe('"he said \\"no\\""')
  })

  test('unterminated string reports -1', () => {
    expect(scanString('"abc', 0)).toBe(-1)
  })

  test('an escaped trailing backslash cannot run off the end', () => {
    expect(scanString('"abc\\', 0)).toBe(-1)
  })

  test('primitive value stops at a structural character', () => {
    expect(scanValue('123,rest', 0)).toBe(3)
    expect(scanValue('true]', 0)).toBe(4)
  })

  test('skipWs crosses every whitespace form', () => {
    expect(skipWs(' \n\t\r x', 0)).toBe(5)
  })
})

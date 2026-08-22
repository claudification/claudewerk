/**
 * The reachability index, with no repo on disk.
 *
 * Split out from `promise-git.test.ts` on purpose: the bucketing is where an
 * abbreviated `closes:` entry either matches or silently falls through to the
 * slow path, and a bug there is invisible against a real repo -- the fallback
 * returns the SAME answer, just two spawns later. Only a direct test can tell
 * "indexed correctly" from "quietly re-asked git every time".
 */

import { describe, expect, test } from 'bun:test'
import { indexCommits, parseRevList } from './promise-main-set'

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const B = 'a1b2ffffffffffffffffffffffffffffffffffff'
const C = '00112233445566778899aabbccddeeff00112233'

describe('indexCommits', () => {
  test('a full sha is a member', () => {
    expect(indexCommits([A, C]).has(A)).toBe(true)
  })

  test('an ABBREVIATED sha is a member -- `closes:` is written at 7-8 chars', () => {
    const set = indexCommits([A, C])
    expect(set.has(A.slice(0, 8))).toBe(true)
    expect(set.has(A.slice(0, 4))).toBe(true)
  })

  test('two shas sharing a bucket prefix both resolve', () => {
    const set = indexCommits([A, B])
    expect(set.has(A.slice(0, 8))).toBe(true)
    expect(set.has(B.slice(0, 8))).toBe(true)
  })

  test('an unknown sha is not a member', () => {
    expect(indexCommits([A]).has(C)).toBe(false)
    expect(indexCommits([A]).has('deadbeef')).toBe(false)
  })

  test('case-insensitive both ways -- git prints lowercase, humans paste either', () => {
    expect(indexCommits([A]).has(A.toUpperCase())).toBe(true)
    expect(indexCommits([A.toUpperCase().toLowerCase()]).has(A)).toBe(true)
  })

  test('a lookup shorter than one bucket cannot match -- it would match anything', () => {
    expect(indexCommits([A]).has('a1b')).toBe(false)
  })
})

describe('parseRevList', () => {
  test('one sha per line, blanks ignored', () => {
    const set = parseRevList(`${A}\n${C}\n\n`)
    expect(set.size).toBe(2)
    expect(set.has(C)).toBe(true)
  })

  /** An empty repo, or a `rev-list` that failed. `size: 0` is what tells the
   *  resolver a miss means "we never looked" rather than "not on main". */
  test('empty stdout indexes to an empty set that matches nothing', () => {
    const set = parseRevList('')
    expect(set.size).toBe(0)
    expect(set.has(A)).toBe(false)
    expect(set.has('')).toBe(false)
  })
})

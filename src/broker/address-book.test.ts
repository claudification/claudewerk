import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBook, getOrAssign, initAddressBook, resolve, slugify } from './address-book'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rclaude-address-book-'))
  initAddressBook(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('address book', () => {
  it('assigns the project slug from the target name (caller-scoped)', () => {
    const id = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(id).toBe('arr')
    expect(resolve('/callers/cwd', 'arr')).toBe('/projects/arr')
  })

  it('returns the same slug for repeated getOrAssign on the same target', () => {
    const a = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    const b = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(a).toBe(b)
  })

  it('does NOT re-slug when the same CWD is reported under different names (project identity is sticky)', () => {
    // First session registers with project name "Arr"
    const first = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(first).toBe('arr')
    // A second session in the same project reports an inconsistent name; the
    // slug must stick to what the project was registered as the first time.
    const second = getOrAssign('/callers/cwd', '/projects/arr', 'something-else')
    expect(second).toBe('arr')
  })

  it('scopes IDs to the caller (leaked IDs are useless elsewhere)', () => {
    getOrAssign('/caller/a', '/projects/arr', 'Arr')
    expect(resolve('/caller/b', 'arr')).toBeUndefined()
  })

  it('collision-suffixes when two different CWDs slug to the same base', () => {
    const one = getOrAssign('/caller', '/projects/arr', 'arr')
    const two = getOrAssign('/caller', '/projects/arr-clone', 'arr')
    expect(one).toBe('arr')
    expect(two).toBe('arr-2')
  })

  it('slugifies reasonably', () => {
    expect(slugify('FRST :: MUSIC :: SITE')).toBe('frst-music-site')
    expect(slugify('  Arr  ')).toBe('arr')
    expect(slugify('')).toBe('project')
  })

  it('wipes a legacy (unversioned) file on init', () => {
    const file = join(tmp, 'address-books.json')
    // Pre-v2 format: bare map, no _version marker -- slugs may be poisoned by
    // the old rule that keyed project slugs off session titles.
    writeFileSync(file, JSON.stringify({ '/caller': { 'blazing-igloo': '/projects/arr' } }))
    initAddressBook(tmp)
    expect(getBook('/caller')).toEqual({})
  })

  it('preserves entries from a same-version file on init', () => {
    const file = join(tmp, 'address-books.json')
    writeFileSync(file, JSON.stringify({ _version: 2, books: { '/caller': { arr: '/projects/arr' } } }))
    initAddressBook(tmp)
    expect(resolve('/caller', 'arr')).toBe('/projects/arr')
  })

  it('persists with the current version marker when scheduled save fires', async () => {
    getOrAssign('/caller', '/projects/arr', 'Arr')
    // scheduleSave debounces 1s; wait slightly longer.
    await new Promise(r => setTimeout(r, 1200))
    const file = join(tmp, 'address-books.json')
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed._version).toBe(2)
    expect(parsed.books['/caller'].arr).toBe('/projects/arr')
  })
})

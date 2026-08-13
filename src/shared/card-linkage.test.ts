import { describe, expect, it } from 'bun:test'
import { LINKAGE_VERBS, linkageVerb, RESOLVABLE_VERBS, storageKey } from './card-linkage'

describe('the registry is closed and self-consistent', () => {
  it('has no duplicate keys', () => {
    const keys = LINKAGE_VERBS.map(v => v.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every alias points at a verb that actually exists', () => {
    for (const alias of LINKAGE_VERBS.filter(v => v.storedAs)) {
      expect(linkageVerb(alias.storedAs as string)).toBeDefined()
    }
  })

  it('no alias points at another alias -- one hop, always', () => {
    for (const alias of LINKAGE_VERBS.filter(v => v.storedAs)) {
      expect(linkageVerb(alias.storedAs as string)?.storedAs).toBeUndefined()
    }
  })

  it('an alias means the same thing as what it stores as', () => {
    for (const alias of LINKAGE_VERBS.filter(v => v.storedAs)) {
      expect(alias.meaning).toBe(linkageVerb(alias.storedAs as string)?.meaning as string)
    }
  })

  it('only card-target verbs carry checks -- a free target has nothing to resolve', () => {
    for (const verb of LINKAGE_VERBS) {
      if (verb.target === 'free') expect(verb.checks).toBeUndefined()
    }
  })

  it('resolvable verbs exclude aliases, so no finding is reported twice', () => {
    expect(RESOLVABLE_VERBS.every(v => !v.storedAs)).toBe(true)
  })
})

describe('relates_to is a real verb', () => {
  it('is registered, targets cards, and is symmetric', () => {
    const verb = linkageVerb('relates_to')
    expect(verb?.target).toBe('card')
    expect(verb?.symmetric).toBe(true)
  })

  it('asserts no ordering, so it has no cycle check', () => {
    expect(linkageVerb('relates_to')?.checks?.cycle).toBeUndefined()
  })

  it('naming yourself is not a contradiction', () => {
    expect(linkageVerb('relates_to')?.selfIsError).toBeFalsy()
  })
})

describe('blocks is parsed but deprecated', () => {
  it('is registered, so a card carrying it is told rather than ignored', () => {
    expect(linkageVerb('blocks')?.deprecated).toBeTruthy()
  })

  it('names depends_on in its remedy', () => {
    expect(linkageVerb('blocks')?.deprecated).toContain('depends_on')
  })
})

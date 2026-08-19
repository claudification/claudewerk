/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cardRefKey,
  matchCardHref,
  peekCard,
  registerCardProvider,
  resetCardProviders,
  resolveCard,
  resolveCardDeep,
  subscribeCards,
} from './registry'
import type { CardLookup, CardProvider, CardRef } from './types'

function fakeProvider(id: string, prefix: string, lookup: CardLookup = { status: 'resolving' }): CardProvider {
  return {
    id,
    matchHref: href => (href.startsWith(prefix) ? { provider: id, id: href.slice(prefix.length), scope: 'S' } : null),
    peek: () => lookup,
    resolve: vi.fn(),
    resolveDeep: vi.fn(),
    subscribe: () => () => {},
  }
}

describe('card registry', () => {
  beforeEach(() => resetCardProviders())

  it('matches hrefs in registration order, first claim wins', () => {
    registerCardProvider(fakeProvider('a', 'a:'))
    registerCardProvider(fakeProvider('b', 'b:'))
    expect(matchCardHref('b:42')).toEqual({ provider: 'b', id: '42', scope: 'S' })
    expect(matchCardHref('nobody:42')).toBeNull()
  })

  it('reports unavailable for a ref whose provider is not registered', () => {
    const orphan: CardRef = { provider: 'gone', id: 'x' }
    expect(peekCard(orphan)).toEqual({ status: 'unavailable' })
    // Neither resolve path may throw on an unknown provider -- a stale link in
    // an old transcript must not take the transcript down.
    expect(() => resolveCard(orphan)).not.toThrow()
    expect(() => resolveCardDeep(orphan)).not.toThrow()
  })

  it('routes resolve + deep resolve to the owning provider', () => {
    const provider = fakeProvider('a', 'a:')
    registerCardProvider(provider)
    const ref = matchCardHref('a:7') as CardRef
    resolveCard(ref)
    resolveCardDeep(ref)
    expect(provider.resolve).toHaveBeenCalledWith(ref)
    expect(provider.resolveDeep).toHaveBeenCalledWith(ref)
  })

  it('fans one subscription out to every provider and unsubscribes all', () => {
    const offA = vi.fn()
    const offB = vi.fn()
    registerCardProvider({ ...fakeProvider('a', 'a:'), subscribe: () => offA })
    registerCardProvider({ ...fakeProvider('b', 'b:'), subscribe: () => offB })
    subscribeCards(() => {})()
    expect(offA).toHaveBeenCalled()
    expect(offB).toHaveBeenCalled()
  })

  it('keys a ref by provider, scope and id so two backends cannot collide', () => {
    expect(cardRefKey({ provider: 'a', id: '1', scope: 'x' })).not.toBe(cardRefKey({ provider: 'b', id: '1' }))
  })
})

/**
 * Provider registry -- the dispatch table the card seam turns on.
 *
 * Registration order is match order, so a specific provider (a GitHub issue URL)
 * can be registered ahead of a broad one. Everything here is a thin fan-out over
 * `CardProvider`; no provider logic lives in this file, which is the point.
 */

import type { CardLookup, CardProvider, CardRef } from './types'

const providers = new Map<string, CardProvider>()
const order: string[] = []

export function registerCardProvider(provider: CardProvider): void {
  if (!providers.has(provider.id)) order.push(provider.id)
  providers.set(provider.id, provider)
}

/** Test seam -- drops every registration. */
export function resetCardProviders(): void {
  providers.clear()
  order.length = 0
}

function providerFor(ref: CardRef): CardProvider | undefined {
  return providers.get(ref.provider)
}

/** The card an href points at, or null when no provider claims it. */
export function matchCardHref(href: string): CardRef | null {
  for (const id of order) {
    const hit = providers.get(id)?.matchHref(href)
    if (hit) return hit
  }
  return null
}

export function peekCard(ref: CardRef): CardLookup {
  return providerFor(ref)?.peek(ref) ?? { status: 'unavailable' }
}

export function resolveCard(ref: CardRef): void {
  providerFor(ref)?.resolve(ref)
}

/** Pull whatever the epic rollup needs. Hover-time only -- it can be expensive. */
export function resolveCardDeep(ref: CardRef): void {
  providerFor(ref)?.resolveDeep?.(ref)
}

/** Subscribe to every registered provider at once. */
export function subscribeCards(fn: () => void): () => void {
  const offs = order.map(id => providers.get(id)?.subscribe(fn)).filter(Boolean) as (() => void)[]
  return () => {
    for (const off of offs) off()
  }
}

export function cardRefKey(ref: CardRef): string {
  return `${ref.provider}:${ref.scope ?? ''}:${ref.id}`
}

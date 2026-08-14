import { beforeEach, describe, expect, it } from 'vitest'
import { CARD_GLYPH, paintCardGlyphs } from './paint-glyphs'
import { registerCardProvider, resetCardProviders } from './registry'
import type { CardLookup, CardProvider, CardSummary } from './types'

function summary(over: Partial<CardSummary> = {}): CardSummary {
  return {
    ref: { provider: 'p', id: 'c1' },
    kind: 'card',
    state: 'active',
    statusLabel: 'in-progress',
    detail: 'full',
    tags: [],
    ...over,
  }
}

function providerReturning(lookup: CardLookup): CardProvider {
  return {
    id: 'p',
    matchHref: href => ({ provider: 'p', id: href }),
    peek: () => lookup,
    resolve: () => {},
    subscribe: () => () => {},
  }
}

function root(): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML =
    '<a class="file-link file-link-card" data-file-path="c1"><span class="card-glyph"></span>c1</a>' +
    '<a class="file-link" data-file-path="docs/x.md">plain</a>'
  return el
}

function glyphOf(el: HTMLElement): { text: string; state?: string; kind?: string } {
  const link = el.querySelector<HTMLElement>('a.file-link-card')
  if (!link) throw new Error('no card link')
  return {
    text: link.querySelector<HTMLElement>('.card-glyph')?.textContent ?? '',
    state: link.dataset.cardState,
    kind: link.dataset.cardKind,
  }
}

describe('paintCardGlyphs', () => {
  beforeEach(() => resetCardProviders())

  it('paints a square in the card state and leaves plain file links alone', () => {
    registerCardProvider(providerReturning({ status: 'ready', summary: summary() }))
    const el = root()
    const refs = paintCardGlyphs(el)
    expect(refs).toHaveLength(1) // only card links are offered to the provider
    expect(glyphOf(el)).toEqual({ text: CARD_GLYPH.card, state: 'active', kind: 'card' })
    expect(el.querySelector('a.file-link:not(.file-link-card)')?.querySelector('.card-glyph')).toBeNull()
  })

  it('paints a hollow diamond for an epic and a filled one at 100%', () => {
    registerCardProvider(
      providerReturning({
        status: 'ready',
        summary: summary({ kind: 'epic', progress: { todo: 1, active: 0, done: 1, dropped: 0, total: 2, pct: 50 } }),
      }),
    )
    const partial = root()
    paintCardGlyphs(partial)
    expect(glyphOf(partial)).toEqual({ text: CARD_GLYPH.epic, state: 'active', kind: 'epic' })

    resetCardProviders()
    registerCardProvider(
      providerReturning({
        status: 'ready',
        summary: summary({
          kind: 'epic',
          state: 'done',
          progress: { todo: 0, active: 0, done: 3, dropped: 1, total: 3, pct: 100 },
        }),
      }),
    )
    const complete = root()
    paintCardGlyphs(complete)
    expect(glyphOf(complete)).toEqual({ text: CARD_GLYPH.epicDone, state: 'done', kind: 'epic' })
  })

  it('spins while resolving, asks with a ? when the id is unknown', () => {
    registerCardProvider(providerReturning({ status: 'resolving' }))
    const pending = root()
    paintCardGlyphs(pending)
    expect(glyphOf(pending)).toMatchObject({ text: CARD_GLYPH.resolving, state: 'resolving' })

    resetCardProviders()
    registerCardProvider(providerReturning({ status: 'unknown' }))
    const missing = root()
    paintCardGlyphs(missing)
    expect(glyphOf(missing)).toMatchObject({ text: CARD_GLYPH.unknown, state: 'unknown' })
  })

  it('falls back to a quiet square when no backend can answer', () => {
    registerCardProvider(providerReturning({ status: 'unavailable' }))
    const el = root()
    paintCardGlyphs(el)
    expect(glyphOf(el)).toMatchObject({ text: CARD_GLYPH.card, state: 'offline' })
  })
})

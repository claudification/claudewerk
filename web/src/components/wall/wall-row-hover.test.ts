/**
 * What a wall row PROMISES when you rest on it, and the two ways that promise
 * silently breaks: a field the row has no value for rendering as `undefined`,
 * and a tap on a phone opening a panel that nothing can dismiss.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { closeCardHover, useCardHover } from '@/components/card-hover/card-hover-bus'
import type { PulseRow } from '@/components/pulse/use-pulse-fleet'
import { hoverCardRow, hoverCommitRow, hoverPulseRow, pulseHoverFacts } from './wall-row-hover'

function row(over: Partial<PulseRow> = {}): PulseRow {
  return {
    id: 'conv_a',
    conversation: { id: 'conv_a' } as PulseRow['conversation'],
    band: 'working',
    title: 'wall-navigation-and-hover',
    project: 'remote-claude',
    action: 'editing wall-navigate.ts and mounting the receiver',
    ageMs: 60_000,
    ...over,
  }
}

/** An anchor whose window says the pointer cannot hover -- i.e. a phone. */
function touchAnchor(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'ownerDocument', {
    value: { defaultView: { matchMedia: () => ({ matches: true }) } },
    configurable: true,
  })
  return el
}

afterEach(() => {
  closeCardHover()
})

describe('pulseHoverFacts', () => {
  it('carries the fields the 407px row had to throw away', () => {
    const facts = pulseHoverFacts(
      row({ model: 'opus-5', host: 'studio', costUsd: 12.5, contextPct: 61.4, tag: 'epic-the-wall-ii' }),
    )

    expect(facts.kicker).toBe('working')
    expect(facts.title).toBe('wall-navigation-and-hover')
    expect(Object.fromEntries(facts.facts)).toMatchObject({
      model: 'opus-5',
      host: 'studio',
      cost: '$12.50',
      context: '61%',
    })
    // The action line IN FULL -- the row truncates it to one column, and being
    // the place it is not truncated is the whole point of the preview.
    expect(facts.body).toBe('editing wall-navigate.ts and mounting the receiver')
    expect(facts.footer).toBe('remote-claude · epic-the-wall-ii')
  })

  it('says NOTHING rather than `undefined` for a field the row has no value for', () => {
    // A blank value is dropped by the panel; `undefined` on screen would be a
    // claim that the number is unknown, which is a different thing from a
    // conversation that has spent nothing yet.
    const facts = pulseHoverFacts(row())
    const shown = Object.fromEntries(facts.facts.filter(([, value]) => value !== ''))

    expect(shown).toEqual({ last: '1m' })
    expect(JSON.stringify(facts)).not.toContain('undefined')
  })

  it('names what is holding a blocked row, and who dispatched a machine run', () => {
    const facts = pulseHoverFacts(
      row({
        band: 'blocked',
        blockedBy: 'permission',
        managedBy: { label: 'epic seat' } as PulseRow['managedBy'],
      }),
    )

    expect(Object.fromEntries(facts.facts)).toMatchObject({ 'blocked by': 'permission', dispatched: 'epic seat' })
  })
})

describe('wall row hover', () => {
  it('opens the ONE shared hover bus rather than a popover of its own', async () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)

    hoverPulseRow(row(), anchor)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(useCardHover.getState().anchor).toBe(anchor)
    expect(useCardHover.getState().content).toMatchObject({ kind: 'facts' })
    // `armed` is what lets app.tsx keep the hover chunk out of the boot bundle.
    expect(useCardHover.getState().armed).toBe(true)
  })

  it('sends a ledger row through the CARD content, so a wall preview and a transcript preview are one panel', async () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)

    hoverCardRow('wall-time-cursor', 'claude:///Users/j/remote-claude', anchor)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(useCardHover.getState().content).toEqual({
      kind: 'card',
      ref: { provider: 'project-board', id: 'wall-time-cursor', scope: 'claude:///Users/j/remote-claude' },
    })
  })

  it('NEVER fires on touch -- a tap synthesises mouseenter and would strand the panel', async () => {
    const anchor = touchAnchor()

    hoverPulseRow(row(), anchor)
    hoverCommitRow({ hash: 'deadbeef' } as never, anchor)
    hoverCardRow('a-card', 'claude://p', anchor)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(useCardHover.getState().content).toBeNull()
  })
})

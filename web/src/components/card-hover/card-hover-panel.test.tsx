import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CardLookup,
  type CardProvider,
  type CardSummary,
  registerCardProvider,
  resetCardProviders,
} from '@/lib/cards'
import { CardHoverPanel } from './card-hover-panel'

const REF = { provider: 'p', id: 'gate-evidence-second-card-writer' }

function provider(lookup: CardLookup): CardProvider {
  return {
    id: 'p',
    matchHref: () => REF,
    peek: () => lookup,
    resolve: () => {},
    resolveDeep: () => {},
    subscribe: () => () => {},
  }
}

function summary(over: Partial<CardSummary> = {}): CardSummary {
  return {
    ref: REF,
    kind: 'card',
    state: 'active',
    statusLabel: 'in-progress',
    detail: 'full',
    title: 'Gate evidence: second card writer bypasses writeGateEvidence()',
    priority: 'high',
    tags: ['board', 'gate'],
    created: '2026-08-11T09:00:00.000Z',
    updated: Date.now() - 3 * 86_400_000,
    ...over,
  }
}

function show(lookup: CardLookup) {
  registerCardProvider(provider(lookup))
  render(<CardHoverPanel cardRef={REF} />)
}

beforeEach(() => resetCardProviders())
afterEach(cleanup)

describe('CardHoverPanel', () => {
  it('shows the spinner state while the backend has not answered', () => {
    show({ status: 'resolving' })
    expect(screen.getByText(/resolving/i)).toBeTruthy()
    expect(screen.getByText(REF.id)).toBeTruthy()
  })

  it('says plainly when nobody claims the id', () => {
    show({ status: 'unknown' })
    expect(screen.getByText(/not on this board/i)).toBeTruthy()
    expect(screen.getByText(/deleted, renamed/i)).toBeTruthy()
  })

  it('shows status, title, tags, id and dates for a card', () => {
    show({ status: 'ready', summary: summary() })
    expect(screen.getByText(/in-progress/)).toBeTruthy()
    expect(screen.getByText(/second card writer/)).toBeTruthy()
    expect(screen.getByText('#board')).toBeTruthy()
    expect(screen.getByText('#gate')).toBeTruthy()
    expect(screen.getByText('high')).toBeTruthy()
    expect(screen.getByText(/created 2026-08-11/)).toBeTruthy()
    expect(screen.getByText(/edited 3d ago/)).toBeTruthy()
    expect(screen.queryByText(/dropped/)).toBeNull()
  })

  it('adds the rollup for an epic, and marks it as one', () => {
    show({
      status: 'ready',
      summary: summary({
        kind: 'epic',
        title: 'ANVIL: card-native spawn pipeline',
        progress: { todo: 4, active: 2, done: 7, dropped: 1, total: 13, pct: 54 },
      }),
    })
    expect(screen.getByText('EPIC')).toBeTruthy()
    expect(screen.getByText(/7\/13/)).toBeTruthy()
    expect(screen.getByText(/54%/)).toBeTruthy()
    expect(screen.getByText(/1 dropped/)).toBeTruthy()
  })

  it('skeletons the title and the bar until detail lands', () => {
    show({
      status: 'ready',
      summary: { ref: REF, kind: 'epic', state: 'todo', statusLabel: 'open', detail: 'partial', tags: [] },
    })
    expect(screen.queryByText(/ANVIL/)).toBeNull()
    expect(screen.getByText('open')).toBeTruthy()
  })
})

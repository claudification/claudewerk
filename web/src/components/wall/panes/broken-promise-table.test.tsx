/**
 * THE LOUD TABLE. The card says this is the whole point of the feature, so these
 * are the tests that decide whether it shipped:
 *
 *  - a card filed as finished with nothing behind it is IN it, by name
 *  - every row says WHY it is there, so the heading never over-claims
 *  - `could not verify` is in the table AND visibly distinct from the rest
 *  - a REFUSAL is not an empty table
 *  - a clean board renders NOTHING -- a permanent "0 broken" banner is furniture
 *  - a cap COUNTS the remainder rather than dropping it in silence
 */

import type { PromiseRow, PromiseVerdict } from '@shared/promise-ledger'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { KANBAN_MODAL } from '@/hooks/use-kanban-modal'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { BrokenPromiseTable, type BrokenRow } from './broken-promise-table'

const ALPHA = 'claude://default/Users/x/alpha'

function row(over: Partial<PromiseRow> & { id: string; verdict: PromiseVerdict }): BrokenRow {
  return {
    project: ALPHA,
    status: 'done',
    title: over.id,
    agreed: null,
    conversation: null,
    session: null,
    asked: null,
    preLedger: false,
    inferred: false,
    closes: [],
    commits: [],
    ...over,
  }
}

const table = () => document.querySelector('.wall-broken')
const rows = () => [...document.querySelectorAll('.wall-broken-row')]
const chips = () => [...document.querySelectorAll('.wall-verdict')]

beforeEach(() => {
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({ pendingTaskEdit: null })
})
afterEach(cleanup)

describe('the loud table', () => {
  it('names the card that was filed as finished with nothing behind it', () => {
    render(<BrokenPromiseTable rows={[row({ id: 'werk-thing', verdict: 'not-started' })]} refused={null} />)

    expect(screen.getByText('FILED AS FINISHED WITH NO COMMIT BEHIND IT')).toBeTruthy()
    expect(screen.getByText('werk-thing')).toBeTruthy()
    expect(screen.getByText('nothing behind it -- no commit was ever named')).toBeTruthy()
    // The count is the headline number, beside the heading.
    expect(document.querySelector('.wall-broken-count')?.textContent).toBe('1')
  })

  it('says why EACH row is there, so the heading never over-claims', () => {
    render(
      <BrokenPromiseTable
        rows={[
          row({ id: 'a', verdict: 'commit-missing' }),
          row({ id: 'b', verdict: 'not-on-main' }),
          row({ id: 'c', verdict: 'unverifiable' }),
          row({ id: 'd', verdict: 'not-started' }),
        ]}
        refused={null}
      />,
    )
    const why = [...document.querySelectorAll('.wall-broken-why')].map(el => el.textContent)
    expect(why).toEqual([
      'names a commit that does not exist',
      'the commit it names is NOT on main',
      'could not verify -- the commit it names was never checked',
      'nothing behind it -- no commit was ever named',
    ])
    // Four rows, four distinct sentences: none of them is folded into another.
    expect(new Set(why).size).toBe(4)
  })

  it('keeps `could not verify` VISIBLY distinct from every other state', () => {
    render(
      <BrokenPromiseTable
        rows={[
          row({ id: 'unknown', verdict: 'unverifiable' }),
          row({ id: 'unclaimed', verdict: 'not-started' }),
          row({ id: 'broken', verdict: 'commit-missing' }),
        ]}
        refused={null}
      />,
    )
    const tones = chips().map(el => el.getAttribute('data-tone'))
    expect(tones).toEqual(['unknown', 'unclaimed', 'broken'])
    // The specific fold the card forbids: `could not verify` wearing the same
    // face as `not started`. Tone AND glyph both have to differ, because the
    // wall row drops the word and keeps only those two.
    expect(tones[0]).not.toBe(tones[1])
    const glyphs = [...document.querySelectorAll('.wall-verdict-glyph')].map(el => el.textContent)
    expect(glyphs[0]).not.toBe(glyphs[1])
    // And the accessible name is the card's own wording, not the abbreviation.
    expect(chips()[0].getAttribute('aria-label')).toBe('could not verify')
  })

  it('renders NOTHING on a clean board -- a "0 broken" banner would be furniture', () => {
    render(<BrokenPromiseTable rows={[]} refused={null} />)
    expect(table()).toBeNull()
  })

  it('a REFUSAL is not an empty table', () => {
    render(<BrokenPromiseTable rows={[]} refused="sentinel timed out (10s)" />)
    // The table renders WITH NO ROWS and says why -- "we cannot tell" has to be
    // a different thing on screen from "nothing is wrong".
    expect(table()).toBeTruthy()
    expect(rows()).toHaveLength(0)
    expect(screen.getByText(/could not check every project -- sentinel timed out/)).toBeTruthy()
  })

  it('COUNTS what the cap hides rather than dropping it in silence', () => {
    const many = Array.from({ length: 9 }, (_, i) => row({ id: `card-${i}`, verdict: 'not-started' }))
    render(<BrokenPromiseTable rows={many} refused={null} />)

    expect(rows()).toHaveLength(6)
    expect(screen.getByText('+ 3 more filed with nothing behind them')).toBeTruthy()
    // The HEADING count is the true total, never the shown slice -- that is the
    // number a person reads from across the room.
    expect(document.querySelector('.wall-broken-count')?.textContent).toBe('9')
  })

  it('opens THAT card on ITS project board when a row is clicked', () => {
    render(<BrokenPromiseTable rows={[row({ id: 'werk-thing', verdict: 'not-started' })]} refused={null} />)
    fireEvent.click(rows()[0] as Element)

    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'werk-thing' })
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]?.scope).toEqual({ type: 'project', uri: ALPHA })
  })
})

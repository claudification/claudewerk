/**
 * The SECOND surface. Same five verdicts, same loud table, same refusal
 * handling -- and it has to say them in the same words as the wall, because a
 * pill on P3 and a row here disagreeing about one card is worse than either
 * alone.
 *
 * The claims:
 *  - the loud table is first, is NOT collapsible, and carries its denominator
 *  - `could not verify` gets its own tone here too, never folded into the grey
 *  - a clean board renders NOTHING
 *  - "no main branch here" is said ONCE, not as five identical grey pills
 */

import type { PromiseLedger } from '@shared/promise-rows'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { resetPromiseLedgerCache } from '@/hooks/use-promise-ledger'
import { ProjectPromisesSection } from './project-promises-section'

const sendBoardOp = vi.fn()
vi.mock('@/hooks/project-task-wire', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/project-task-wire')>()
  return { ...actual, sendBoardOp: (...args: unknown[]) => sendBoardOp(...args) }
})

const ALPHA = 'claude://default/Users/x/alpha'

type Row = PromiseLedger['rows'][number]

function promise(id: string, verdict: Row['verdict'], over: Partial<Row> = {}): Row {
  return {
    id,
    status: 'done',
    title: id,
    agreed: null,
    conversation: null,
    session: null,
    asked: null,
    preLedger: false,
    inferred: false,
    closes: [],
    commits: [],
    verdict,
    ...over,
  }
}

function reply(rows: Row[], over: Partial<PromiseLedger> = {}) {
  sendBoardOp.mockResolvedValue({
    ok: true,
    promises: { project: ALPHA, rows, scanned: 372, resolverBase: 'main', scannedAt: 1, ...over },
  })
}

beforeEach(() => {
  resetPromiseLedgerCache()
  sendBoardOp.mockReset()
  useConversationsStore.setState({ pendingTaskEdit: null })
})
afterEach(cleanup)

describe('the project panel promise ledger', () => {
  it('leads with the loud table, names the card, and prints the denominator', async () => {
    reply([promise('werk-thing', 'not-started')])
    render(<ProjectPromisesSection projectUri={ALPHA} />)

    await waitFor(() => expect(screen.getByText(/Filed as finished with NO commit behind it/)).toBeTruthy())
    expect(screen.getByText(/\(1\)/)).toBeTruthy()
    // `1 of 372` is a different sentence from a bare `1`.
    expect(screen.getByText('of 372 cards')).toBeTruthy()
    expect(screen.getByText('werk-thing')).toBeTruthy()
    expect(screen.getByText('nothing behind it -- no commit was ever named')).toBeTruthy()
  })

  it('has NO collapse control on the loud table', async () => {
    reply([promise('werk-thing', 'not-started')])
    const { container } = render(<ProjectPromisesSection projectUri={ALPHA} />)
    await waitFor(() => expect(screen.getByText('werk-thing')).toBeTruthy())

    // Every other section on this panel folds away. This one must not: a
    // one-click "hide the thing I did not do" sitting next to the thing is the
    // affordance the whole feature exists to remove. The only buttons here are
    // the rows themselves.
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('werk-thing')
  })

  it('tallies all five verdicts with `could not verify` on its own tone', async () => {
    reply([
      promise('a', 'commit-missing'),
      promise('b', 'not-on-main'),
      promise('c', 'unverifiable'),
      promise('d', 'not-started'),
      promise('e', 'delivered'),
    ])
    render(<ProjectPromisesSection projectUri={ALPHA} />)

    await waitFor(() => expect(screen.getByText(/1 could not verify/)).toBeTruthy())
    // Worst first, and every one of the five present with the card's own words.
    for (const label of [
      '1 names a commit that does not exist',
      '1 commit is NOT on main',
      '1 could not verify',
      '1 not started',
      '1 delivered',
    ]) {
      expect(screen.getByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy()
    }

    // `could not verify` is text-info; `not started` is the muted grey. The fold
    // the card forbids is exactly these two sharing a class.
    const unknown = screen.getByText(/1 could not verify/)
    const unclaimed = screen.getByText(/1 not started/)
    expect(unknown.className).toContain('text-info')
    expect(unclaimed.className).not.toContain('text-info')
  })

  it('renders NOTHING for a board with no promises and nothing filed badly', async () => {
    reply([])
    const { container } = render(<ProjectPromisesSection projectUri={ALPHA} />)
    await waitFor(() => expect(sendBoardOp).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('renders NOTHING before an answer -- "clean" is a claim, and we have no evidence yet', () => {
    sendBoardOp.mockReturnValue(new Promise(() => {}))
    const { container } = render(<ProjectPromisesSection projectUri={ALPHA} />)
    expect(container.textContent).toBe('')
  })

  it('says a refusal out loud instead of showing an empty ledger', async () => {
    sendBoardOp.mockResolvedValue({ ok: false, error: 'unknown op: promises' })
    render(<ProjectPromisesSection projectUri={ALPHA} />)
    await waitFor(() => expect(screen.getByText(/promise ledger: unknown op: promises/)).toBeTruthy())
  })

  it('says "no main branch here" once, instead of five identical grey pills', async () => {
    reply([promise('a', 'unverifiable'), promise('b', 'unverifiable')], { resolverBase: null })
    render(<ProjectPromisesSection projectUri={ALPHA} />)

    await waitFor(() =>
      expect(screen.getByText('no main branch here -- nothing could be checked against it')).toBeTruthy(),
    )
    // The REASON is stated once, as a fact about the repo. The tally aggregates
    // the two rows into one entry rather than repeating the same shrug twice --
    // a column of identical grey pills is what makes a reader stop reading, and
    // none of them would have explained that there was no `main` to check.
    expect(screen.getAllByText('no main branch here -- nothing could be checked against it')).toHaveLength(1)
    expect(screen.getAllByText(/2 could not verify/)).toHaveLength(1)
  })

  it('opens the card when a broken row is clicked', async () => {
    reply([promise('werk-thing', 'not-started')])
    render(<ProjectPromisesSection projectUri={ALPHA} />)
    await waitFor(() => expect(screen.getByText('werk-thing')).toBeTruthy())

    fireEvent.click(screen.getByText('werk-thing'))
    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'werk-thing' })
  })
})

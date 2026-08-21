/**
 * The chip's accessible name, which was silently dropped on the floor.
 *
 * REGRESSION. The chip was a bare `<span aria-label={face.long}>` wrapping an
 * `aria-hidden` glyph. A `<span>` carries no implicit ARIA role, and an
 * `aria-label` on a role-less generic element is DISCARDED by the accessibility
 * tree -- so the full wording the component's own doc comment promises ("names a
 * commit that does not exist") reached no screen reader, and at `showWord=false`
 * the chip announced nothing at all. Caught by biome's
 * `a11y/useAriaPropsSupportedByRole`, which was the single error-level
 * diagnostic keeping `bun run lint:fast` red on main.
 *
 * These tests assert the two halves that failure needs: the role that makes the
 * label legal, and the label itself being the LONG wording rather than the
 * column-width abbreviation.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PromiseVerdictChip } from './promise-verdict-chip'

afterEach(cleanup)

describe('PromiseVerdictChip', () => {
  it('exposes an accessible name, which needs an explicit role on a span', () => {
    render(<PromiseVerdictChip verdict="commit-missing" />)
    expect(screen.getByRole('img', { name: 'names a commit that does not exist' })).toBeTruthy()
  })

  it('still names itself with the word hidden, which is the whole point of the label', () => {
    render(<PromiseVerdictChip showWord={false} verdict="unverifiable" />)
    const chip = screen.getByRole('img', { name: 'could not verify' })
    expect(chip.textContent).toBe('?')
  })

  it('carries the LONG wording, never the column-width short form', () => {
    render(<PromiseVerdictChip verdict="pre-ledger" />)
    expect(screen.getByRole('img', { name: 'filed before the ledger existed' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'pre-ledger' })).toBeNull()
  })
})

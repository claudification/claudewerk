import { SCANNER_CONTRACTS } from '@shared/scanner-contracts'
import { SCANNER_IDS } from '@shared/scanner-ids'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScannerContractCard } from './scanner-contract-card'

afterEach(cleanup)

/** The whole card as one string -- these assertions are about what a human can
 *  READ, not about which element it landed in. */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

describe('ScannerContractCard', () => {
  it('answers all five questions for every declared scanner', () => {
    for (const id of SCANNER_IDS) {
      const contract = SCANNER_CONTRACTS[id]
      render(<ScannerContractCard contract={contract} lastRun={undefined} />)
      const body = text()
      expect(body, `${id}: what it selects`).toContain(contract.selects)
      expect(body, `${id}: what it dispatches`).toContain(contract.dispatches)
      expect(body, `${id}: what it costs`).toContain(contract.cost)
      expect(body, `${id}: whether a verifier follows`).toContain(contract.verifierFollows)
      for (const skip of contract.skips) expect(body, `${id}: skips ${skip.bucket}`).toContain(skip.bucket)
      cleanup()
    }
  })

  it('names the tag it triggers on, for every tag-driven scanner', () => {
    for (const id of SCANNER_IDS) {
      const contract = SCANNER_CONTRACTS[id]
      if (contract.tag === undefined) continue
      render(<ScannerContractCard contract={contract} lastRun={undefined} />)
      expect(text(), `${id}: names \`${contract.tag}\``).toContain(contract.tag)
      cleanup()
    }
  })

  it('names the seat a dispatching scanner spends, so nobody has to guess the cost', () => {
    for (const id of SCANNER_IDS) {
      const contract = SCANNER_CONTRACTS[id]
      if (contract.seat === undefined) continue
      render(<ScannerContractCard contract={contract} lastRun={undefined} />)
      expect(text(), `${id}: names ${contract.seat}`).toContain(contract.seat)
      cleanup()
    }
  })

  it('says "no caller yet" rather than inventing a cadence for a scanner nothing schedules', () => {
    // A HAND-BUILT contract, because no shipped one reaches this branch any
    // more: `refine` and `work-order` were exactly this case -- built, tested,
    // invoked by nothing -- until `scanner-clock.ts` gave them a clock, and
    // `morning-report` is caught one branch earlier as not built at all. The
    // rule is for the NEXT scanner written ahead of its caller, and a made-up
    // interval there would turn the one alarming sentence on this screen into a
    // puzzle.
    render(<ScannerContractCard contract={{ ...SCANNER_CONTRACTS.refine, cadence: undefined }} lastRun={undefined} />)
    expect(text()).toContain('no caller yet -- never scheduled')
  })

  it('every built scanner in the shipped table states an interval', () => {
    for (const id of SCANNER_IDS) {
      const contract = SCANNER_CONTRACTS[id]
      if (!contract.built) continue
      render(<ScannerContractCard contract={contract} lastRun={undefined} />)
      expect(text(), `${id}: names its cadence`).toContain(contract.cadence ?? 'MISSING')
      expect(text(), `${id}: no longer claims nothing calls it`).not.toContain('no caller yet')
      cleanup()
    }
  })

  it('says a scanner with no implementation is not built, rather than describing one', () => {
    render(<ScannerContractCard contract={SCANNER_CONTRACTS['morning-report']} lastRun={undefined} />)
    expect(text()).toContain('not built yet -- nothing behind this box')
  })

  it('states the cadence a scheduled scanner actually runs at', () => {
    render(<ScannerContractCard contract={SCANNER_CONTRACTS.epics} lastRun={undefined} />)
    expect(text()).toContain('every 45s')
  })

  it('carries the last-run stamp beside the cadence', () => {
    render(<ScannerContractCard contract={SCANNER_CONTRACTS.epics} lastRun={Date.now() - 120_000} />)
    expect(screen.getByText('last ran 2m ago')).toBeDefined()
  })

  it('says "last ran never" when the scanner has no stamp', () => {
    render(<ScannerContractCard contract={SCANNER_CONTRACTS.epics} lastRun={undefined} />)
    expect(screen.getByText('last ran never')).toBeDefined()
  })
})

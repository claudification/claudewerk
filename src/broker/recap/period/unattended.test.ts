import { describe, expect, it } from 'bun:test'
import { resolveSuiteId } from '../../../shared/recap-suites'
import { isUnattendedRun } from './orchestrator'

// REGRESSION -- the nightly lessons scavenger failed 19 of 20 nights and spent
// $58 producing nothing, and nobody noticed for a month. Not because the failure
// was hidden: because it was only ever a log line, and a 04:00 job has no one
// reading logs at 04:00. This predicate decides which failures have to go find a
// human instead of waiting to be discovered.
describe('isUnattendedRun', () => {
  it('is true for a scheduled run with nobody waiting (the nightly)', () => {
    expect(isUnattendedRun({ createdBy: 'lessons-scavenger' })).toBe(true)
  })

  it('is false when a conversation asked -- it gets told directly', () => {
    expect(isUnattendedRun({ createdBy: 'lessons-scavenger', informConversationId: 'conv_1' })).toBe(false)
  })

  it('is false for a human clicking Generate -- they are looking at the failure', () => {
    expect(isUnattendedRun({})).toBe(false)
    expect(isUnattendedRun({ informConversationId: 'conv_1' })).toBe(false)
  })
})

// The tier routing hangs off this predicate, so the mapping is load-bearing:
// if anything ever starts stamping createdBy on dashboard-initiated recaps,
// every user-requested recap silently drops to the economy model and nobody
// gets an error. Verified against the live store on 2026-07-27: createdBy is
// set ONLY by machine schedulers (lessons-scavenger 20, lessons-ledger 1) and
// is NULL on all 43 user-requested rows.
describe('suite routing follows provenance', () => {
  it('routes the nightly scavenger to the cheap suite', () => {
    expect(resolveSuiteId({ unattended: isUnattendedRun({ createdBy: 'lessons-scavenger' }) }).id).toBe('cheap')
  })

  it('routes a dashboard recap (no createdBy) to the accurate suite', () => {
    expect(resolveSuiteId({ unattended: isUnattendedRun({}) }).id).toBe('accurate')
  })

  it('routes an agent-requested recap with an inform target to the accurate suite', () => {
    // A conversation asked and is waiting on the answer -- that is a user, via a proxy.
    expect(
      resolveSuiteId({ unattended: isUnattendedRun({ createdBy: 'agent', informConversationId: 'conv_1' }) }).id,
    ).toBe('accurate')
  })
})

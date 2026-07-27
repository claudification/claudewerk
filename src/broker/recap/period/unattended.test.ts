import { describe, expect, it } from 'bun:test'
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

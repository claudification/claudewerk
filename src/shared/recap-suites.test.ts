import { describe, expect, it } from 'bun:test'
import { DEFAULT_SUITE_ID, getSuite, isRecapSuiteId, listSuites, resolveSuiteId } from './recap-suites'

describe('suite registry', () => {
  it('exposes both suites for a picker', () => {
    expect(
      listSuites()
        .map(s => s.id)
        .sort(),
    ).toEqual(['accurate', 'cheap'])
    for (const s of listSuites()) {
      expect(s.label).toBeTruthy()
      expect(s.description).toBeTruthy()
      expect(s.approxSynthesisUsd).toBeGreaterThan(0)
    }
  })

  it("never throws on a bad id -- a typo must not fail someone's real recap", () => {
    expect(getSuite('nope').id).toBe(DEFAULT_SUITE_ID)
    expect(getSuite(undefined).id).toBe(DEFAULT_SUITE_ID)
    expect(isRecapSuiteId('cheap')).toBe(true)
    expect(isRecapSuiteId('nope')).toBe(false)
  })

  it('defaults to accurate -- a surprise downgrade is worse than a surprise bill', () => {
    expect(DEFAULT_SUITE_ID).toBe('accurate')
  })
})

// The cascade is the whole point of making suites configurable: the model choice
// is a DEFAULT, not policy. Each level below must be beatable by the one above,
// and every branch is load-bearing, so each gets its own case.
describe('resolveSuiteId precedence', () => {
  it('1. an explicitly requested suite wins over everything', () => {
    expect(
      resolveSuiteId({ requested: 'cheap', projectDefault: 'accurate', unattended: false, customerFriendly: true }),
    ).toEqual({ id: 'cheap', source: 'requested' })
  })

  it('2. customer-facing beats a project default', () => {
    // Content leaving the team is never quietly downgraded by a background
    // setting somebody configured months ago for cost reasons.
    expect(resolveSuiteId({ projectDefault: 'cheap', unattended: false, customerFriendly: true })).toEqual({
      id: 'accurate',
      source: 'customer-facing',
    })
  })

  it('2. customer-facing beats the unattended fallback too', () => {
    expect(resolveSuiteId({ unattended: true, customerFriendly: true })).toEqual({
      id: 'accurate',
      source: 'customer-facing',
    })
  })

  it('3. a project default beats the provenance fallback', () => {
    expect(resolveSuiteId({ projectDefault: 'accurate', unattended: true })).toEqual({
      id: 'accurate',
      source: 'project-default',
    })
    expect(resolveSuiteId({ projectDefault: 'cheap', unattended: false })).toEqual({
      id: 'cheap',
      source: 'project-default',
    })
  })

  it('4. an unattended run falls back to cheap', () => {
    expect(resolveSuiteId({ unattended: true })).toEqual({ id: 'cheap', source: 'unattended' })
  })

  it('5. anything a person is waiting on falls back to accurate', () => {
    expect(resolveSuiteId({ unattended: false })).toEqual({ id: 'accurate', source: 'default' })
  })

  it('ignores junk at every level instead of honouring it', () => {
    // A bad value must fall THROUGH to the next level, not be treated as a
    // choice -- otherwise a typo silently pins a suite nobody asked for.
    expect(resolveSuiteId({ requested: 'delux', unattended: true })).toEqual({ id: 'cheap', source: 'unattended' })
    expect(resolveSuiteId({ projectDefault: 'delux', unattended: true })).toEqual({
      id: 'cheap',
      source: 'unattended',
    })
  })

  it('reports WHY, so a past recap can explain its own models', () => {
    expect(resolveSuiteId({ requested: 'cheap', unattended: false }).source).toBe('requested')
    expect(resolveSuiteId({ unattended: true }).source).toBe('unattended')
  })
})

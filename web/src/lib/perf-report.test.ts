import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetMessageContext, beginMessage, endMessage } from './perf-message-context'
import { clearEntries, record, setPerfEnabled } from './perf-metrics'
import { buildPerfReport } from './perf-report'

describe('buildPerfReport', () => {
  beforeEach(() => {
    _resetMessageContext()
    setPerfEnabled(true)
    clearEntries()
  })
  afterEach(() => {
    setPerfEnabled(false)
    clearEntries()
  })

  it('emits Summary + By message + Timeline sections with attributed types', () => {
    beginMessage('conversation_update')
    record('message', 'apply:conversation_update', 4)
    endMessage()
    record('render', 'ProjectList', 7, 'conversation_update')

    const report = buildPerfReport({ now: '2026-06-10T00:00:00.000Z' })
    expect(report).toContain('# Perf Report')
    expect(report).toContain('2026-06-10T00:00:00.000Z')
    expect(report).toContain('## Summary')
    expect(report).toContain('## By message')
    expect(report).toContain('conversation_update')
    expect(report).toContain('## Timeline')
    // the message-attribution tag is rendered in the timeline line
    expect(report).toContain('<conversation_update>')
  })

  it('significantOnly drops sub-threshold samples from By message', () => {
    record('render', 'Tiny', 0.4, 'token_sample')
    const full = buildPerfReport({ significantOnly: false })
    const sig = buildPerfReport({ significantOnly: true })
    expect(full).toContain('token_sample')
    expect(sig).not.toContain('token_sample')
  })
})

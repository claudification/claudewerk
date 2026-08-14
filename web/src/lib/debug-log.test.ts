import { beforeEach, describe, expect, test } from 'vitest'
import { clearLog, copyLogText, getLogEntries, getVisibleLogEntries, installLogCapture } from './debug-log'
import { _resetLogFilterForTests, setLogLevelFilter } from './debug-log-filter'

installLogCapture()

beforeEach(() => {
  clearLog()
  localStorage.clear()
  _resetLogFilterForTests()
})

describe('debug-log buffer', () => {
  test('caps the ring buffer at 1000 entries, dropping the oldest', () => {
    for (let i = 0; i < 1200; i++) console.log(`line-${i}`)
    const entries = getLogEntries()
    expect(entries.length).toBe(1000)
    expect(entries[0].args).toBe('line-200')
    expect(entries[entries.length - 1].args).toBe('line-1199')
  })

  test('caps a single huge entry so one log call cannot pin megabytes', () => {
    console.log('x'.repeat(500_000))
    const entry = getLogEntries()[0]
    expect(entry.args.length).toBeLessThan(9_000)
    expect(entry.args).toContain('[truncated')
  })

  test('captures every level regardless of the view filter', () => {
    setLogLevelFilter(new Set(['error']))
    console.debug('a debug line')
    console.error('an error line')
    // Capture is complete...
    expect(getLogEntries().length).toBe(2)
    // ...the filter only decides what is shown.
    expect(getVisibleLogEntries().map(e => e.level)).toEqual(['error'])
  })
})

describe('copyLogText', () => {
  test('copies only the levels the filter admits', () => {
    console.debug('noisy detail')
    console.error('the actual failure')
    setLogLevelFilter(new Set(['error']))
    const text = copyLogText()
    expect(text).toContain('the actual failure')
    expect(text).not.toContain('noisy detail')
  })

  test('includes every level when nothing is filtered out', () => {
    console.debug('noisy detail')
    console.error('the actual failure')
    const text = copyLogText()
    expect(text).toContain('noisy detail')
    expect(text).toContain('the actual failure')
  })

  test('respects the line limit after filtering, not before', () => {
    for (let i = 0; i < 50; i++) console.debug(`noise-${i}`)
    for (let i = 0; i < 5; i++) console.error(`fail-${i}`)
    setLogLevelFilter(new Set(['error']))
    const lines = copyLogText(10).split('\n')
    expect(lines.length).toBe(5)
    expect(lines.every(l => l.includes('ERROR'))).toBe(true)
  })
})

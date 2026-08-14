/**
 * The debug console's contract: the level filter changes what is RENDERED
 * (never what is captured), and the count reflects both numbers when a filter
 * is hiding something.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { clearLog, installLogCapture } from '@/lib/debug-log'
import { _resetLogFilterForTests, setLogLevelFilter } from '@/lib/debug-log-filter'
import { DebugConsole } from './debug-console'

installLogCapture()

beforeEach(() => {
  clearLog()
  localStorage.clear()
  _resetLogFilterForTests()
})

// Auto-cleanup is not configured globally here, so an un-unmounted console from
// a previous case would make every getBy* ambiguous.
afterEach(cleanup)

function noop() {}

describe('DebugConsole', () => {
  test('renders every level when nothing is filtered', () => {
    console.debug('a-debug-line')
    console.error('an-error-line')
    render(<DebugConsole onClose={noop} />)
    expect(screen.getByText('a-debug-line')).toBeTruthy()
    expect(screen.getByText('an-error-line')).toBeTruthy()
    expect(screen.getByText('Debug Console (2)')).toBeTruthy()
  })

  test('hides filtered-out levels and shows shown/total in the count', () => {
    console.debug('a-debug-line')
    console.error('an-error-line')
    setLogLevelFilter(new Set(['error']))
    render(<DebugConsole onClose={noop} />)
    expect(screen.queryByText('a-debug-line')).toBeNull()
    expect(screen.getByText('an-error-line')).toBeTruthy()
    expect(screen.getByText('Debug Console (1/2)')).toBeTruthy()
  })

  test('renders the empty state when the filter admits nothing', () => {
    console.debug('a-debug-line')
    setLogLevelFilter(new Set(['error']))
    render(<DebugConsole onClose={noop} />)
    expect(screen.getByText('No log entries yet')).toBeTruthy()
  })

  test('marks the active levels on the filter chips', () => {
    setLogLevelFilter(new Set(['error', 'warn']))
    render(<DebugConsole onClose={noop} />)
    expect(screen.getByTitle('Hide error lines (view + copy)')).toBeTruthy()
    expect(screen.getByTitle('Show debug lines')).toBeTruthy()
  })
})

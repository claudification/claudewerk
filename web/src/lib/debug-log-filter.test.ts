import { beforeEach, describe, expect, test } from 'vitest'
import {
  _resetLogFilterForTests,
  getLogLevelFilter,
  isLevelVisible,
  LOG_LEVELS,
  setLogLevelFilter,
  toggleLogLevel,
} from './debug-log-filter'

const KEY = 'rclaude.debugLogLevels'

beforeEach(() => {
  localStorage.clear()
  _resetLogFilterForTests()
})

describe('debug-log-filter', () => {
  test('defaults to every level visible', () => {
    expect(getLogLevelFilter().size).toBe(LOG_LEVELS.length)
    expect(isLevelVisible('debug')).toBe(true)
  })

  test('toggling a level off persists the remaining set', () => {
    toggleLogLevel('debug')
    expect(isLevelVisible('debug')).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).not.toContain('debug')
  })

  test('reloads the persisted set from localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify(['warn', 'error']))
    _resetLogFilterForTests()
    expect(isLevelVisible('warn')).toBe(true)
    expect(isLevelVisible('log')).toBe(false)
  })

  test('refuses to turn off the last level, which would blank the console', () => {
    setLogLevelFilter(new Set(['error']))
    toggleLogLevel('error')
    expect(isLevelVisible('error')).toBe(true)
  })

  test('an empty or malformed stored value falls back to all levels', () => {
    for (const stored of ['[]', 'not json', '{"a":1}', JSON.stringify(['bogus'])]) {
      localStorage.setItem(KEY, stored)
      _resetLogFilterForTests()
      expect(getLogLevelFilter().size).toBe(LOG_LEVELS.length)
    }
  })

  test('hands out a stable reference until the filter changes', () => {
    const first = getLogLevelFilter()
    expect(getLogLevelFilter()).toBe(first)
    toggleLogLevel('debug')
    expect(getLogLevelFilter()).not.toBe(first)
  })

  test('toggling a level back on restores it', () => {
    toggleLogLevel('warn')
    expect(isLevelVisible('warn')).toBe(false)
    toggleLogLevel('warn')
    expect(isLevelVisible('warn')).toBe(true)
  })
})

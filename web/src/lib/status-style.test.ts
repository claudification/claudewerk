import { describe, expect, it } from 'vitest'
import { formatAgeShort, isStatusSuperseded } from './status-style'
import type { LiveStatus } from './types'

const status = (updatedAt: number): LiveStatus => ({ state: 'done', seq: 1, updatedAt })

describe('isStatusSuperseded', () => {
  it('is false when no status', () => {
    expect(isStatusSuperseded(undefined, Date.now())).toBe(false)
  })

  it('is false when there is no recorded user input', () => {
    expect(isStatusSuperseded(status(1000), undefined)).toBe(false)
  })

  it('is false when the last input predates the status (status is current)', () => {
    expect(isStatusSuperseded(status(5000), 4000)).toBe(false)
  })

  it('is false when input equals updatedAt (the impulse that produced the status)', () => {
    expect(isStatusSuperseded(status(5000), 5000)).toBe(false)
  })

  it('is true when the user posted input AFTER the status was set (superseded)', () => {
    expect(isStatusSuperseded(status(5000), 6000)).toBe(true)
  })
})

describe('formatAgeShort', () => {
  it('renders seconds / minutes / hours / days compactly', () => {
    const now = Date.now()
    expect(formatAgeShort(now - 5_000)).toBe('5s')
    expect(formatAgeShort(now - 4 * 60_000)).toBe('4m')
    expect(formatAgeShort(now - 2 * 3_600_000)).toBe('2h')
    expect(formatAgeShort(now - 3 * 86_400_000)).toBe('3d')
  })

  it('never goes negative for a future timestamp', () => {
    expect(formatAgeShort(Date.now() + 10_000)).toBe('0s')
  })
})

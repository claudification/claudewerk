/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { clearThinkingProgress, getThinkingProgress, recordThinkingProgress } from './thinking-progress-store'

describe('thinking-progress-store', () => {
  test('records samples and keeps last N', () => {
    const id = 'conv_test_records'
    for (let i = 0; i < 20; i++) {
      recordThinkingProgress(id, { tokens: i * 100, delta: 100, t: 1000 + i * 100 })
    }
    const entry = getThinkingProgress(id)
    expect(entry).toBeDefined()
    expect(entry!.samples.length).toBe(16)
    expect(entry!.samples[entry!.samples.length - 1].tokens).toBe(1900)
    expect(entry!.lastTickAt).toBe(2900)
    clearThinkingProgress(id)
  })

  test('startedAt is set on first ping and preserved', () => {
    const id = 'conv_test_started'
    recordThinkingProgress(id, { tokens: 50, t: 5000 })
    recordThinkingProgress(id, { tokens: 150, delta: 100, t: 5500 })
    const entry = getThinkingProgress(id)
    expect(entry!.startedAt).toBe(5000)
    expect(entry!.lastTickAt).toBe(5500)
    clearThinkingProgress(id)
  })

  test('clearThinkingProgress removes entry', () => {
    const id = 'conv_test_clear'
    recordThinkingProgress(id, { tokens: 10, t: 1 })
    expect(getThinkingProgress(id)).toBeDefined()
    clearThinkingProgress(id)
    expect(getThinkingProgress(id)).toBeUndefined()
  })

  test('clear on a non-existent id is a no-op', () => {
    expect(() => clearThinkingProgress('conv_nonexistent')).not.toThrow()
  })
})

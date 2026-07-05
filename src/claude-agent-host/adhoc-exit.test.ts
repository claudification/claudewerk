import { describe, expect, test } from 'bun:test'
import { shouldExitAfterResult, shouldExitAfterResultFromEnv } from './adhoc-exit'

describe('shouldExitAfterResult', () => {
  // H7 finding 2: a fire-and-forget (adHoc) worker exits after its result; a
  // non-adHoc headless session stays alive for follow-up prompts.
  test('adHoc without leaveRunning => exit', () => {
    expect(shouldExitAfterResult({ adHoc: true, leaveRunning: false })).toBe(true)
  })

  test('adHoc WITH leaveRunning => stay alive', () => {
    expect(shouldExitAfterResult({ adHoc: true, leaveRunning: true })).toBe(false)
  })

  test('non-adHoc headless => stay alive regardless of leaveRunning', () => {
    expect(shouldExitAfterResult({ adHoc: false, leaveRunning: false })).toBe(false)
    expect(shouldExitAfterResult({ adHoc: false, leaveRunning: true })).toBe(false)
  })
})

describe('shouldExitAfterResultFromEnv', () => {
  test('reads the sentinel-set env flags', () => {
    // The nightshift/quest dispatch sets RCLAUDE_ADHOC=1 (and no leaveRunning),
    // so the worker exits on completion.
    expect(shouldExitAfterResultFromEnv({ RCLAUDE_ADHOC: '1' })).toBe(true)
    expect(shouldExitAfterResultFromEnv({ RCLAUDE_ADHOC: '1', RCLAUDE_LEAVE_RUNNING: '1' })).toBe(false)
    expect(shouldExitAfterResultFromEnv({})).toBe(false)
    expect(shouldExitAfterResultFromEnv({ RCLAUDE_ADHOC: '0' })).toBe(false)
  })
})

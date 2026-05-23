/**
 * process-model -- pure transport <-> (isDaemon, headless) mapping for the
 * spawn dialog's "Process model" segmented control (transport reframe).
 */

import { describe, expect, test } from 'vitest'
import {
  type ClaudeTransport,
  deriveClaudeTransport,
  isClaudeFamilyBackend,
  processModelToState,
} from './process-model'

describe('isClaudeFamilyBackend', () => {
  test('claude / undefined own a process model', () => {
    expect(isClaudeFamilyBackend('claude')).toBe(true)
    expect(isClaudeFamilyBackend(undefined)).toBe(true)
  })

  test('the daemon is NOT a backend (it is a claude transport)', () => {
    expect(isClaudeFamilyBackend('daemon')).toBe(false)
  })

  test('other backends do not own a process model', () => {
    expect(isClaudeFamilyBackend('opencode')).toBe(false)
    expect(isClaudeFamilyBackend('chat-api')).toBe(false)
    expect(isClaudeFamilyBackend('hermes')).toBe(false)
  })
})

describe('deriveClaudeTransport', () => {
  test('isDaemon -> claude-daemon regardless of headless', () => {
    expect(deriveClaudeTransport(true, true)).toBe('claude-daemon')
    expect(deriveClaudeTransport(true, false)).toBe('claude-daemon')
  })

  test('not daemon -> headless picks stream-json vs PTY', () => {
    expect(deriveClaudeTransport(false, true)).toBe('claude-headless')
    expect(deriveClaudeTransport(false, false)).toBe('claude-pty')
  })
})

describe('processModelToState', () => {
  test('daemon preserves the previous headless flag', () => {
    expect(processModelToState('claude-daemon', true)).toEqual({ isDaemon: true, headless: true })
    expect(processModelToState('claude-daemon', false)).toEqual({ isDaemon: true, headless: false })
  })

  test('headless / pty set isDaemon=false and the matching flag', () => {
    expect(processModelToState('claude-headless', false)).toEqual({ isDaemon: false, headless: true })
    expect(processModelToState('claude-pty', true)).toEqual({ isDaemon: false, headless: false })
  })

  test('round-trips through deriveClaudeTransport', () => {
    const models: ClaudeTransport[] = ['claude-pty', 'claude-headless', 'claude-daemon']
    for (const pm of models) {
      const { isDaemon, headless } = processModelToState(pm, true)
      expect(deriveClaudeTransport(isDaemon, headless)).toBe(pm)
    }
  })
})

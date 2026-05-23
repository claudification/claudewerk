/**
 * process-model -- pure transport <-> (backend, headless) mapping for the
 * spawn dialog's "Process model" segmented control (transport reframe Phase 5).
 */

import { describe, expect, test } from 'vitest'
import {
  type ClaudeTransport,
  deriveClaudeTransport,
  isClaudeFamilyBackend,
  processModelToBackendHeadless,
} from './process-model'

describe('isClaudeFamilyBackend', () => {
  test('claude / daemon / undefined own a process model', () => {
    expect(isClaudeFamilyBackend('claude')).toBe(true)
    expect(isClaudeFamilyBackend('daemon')).toBe(true)
    expect(isClaudeFamilyBackend(undefined)).toBe(true)
  })

  test('other backends do not', () => {
    expect(isClaudeFamilyBackend('opencode')).toBe(false)
    expect(isClaudeFamilyBackend('chat-api')).toBe(false)
    expect(isClaudeFamilyBackend('hermes')).toBe(false)
  })
})

describe('deriveClaudeTransport', () => {
  test('daemon backend -> claude-daemon regardless of headless', () => {
    expect(deriveClaudeTransport('daemon', true)).toBe('claude-daemon')
    expect(deriveClaudeTransport('daemon', false)).toBe('claude-daemon')
  })

  test('claude backend -> headless picks stream-json vs PTY', () => {
    expect(deriveClaudeTransport('claude', true)).toBe('claude-headless')
    expect(deriveClaudeTransport('claude', false)).toBe('claude-pty')
    expect(deriveClaudeTransport(undefined, true)).toBe('claude-headless')
  })
})

describe('processModelToBackendHeadless', () => {
  test('daemon preserves the previous headless flag', () => {
    expect(processModelToBackendHeadless('claude-daemon', true)).toEqual({ backend: 'daemon', headless: true })
    expect(processModelToBackendHeadless('claude-daemon', false)).toEqual({ backend: 'daemon', headless: false })
  })

  test('headless / pty set backend=claude and the matching flag', () => {
    expect(processModelToBackendHeadless('claude-headless', false)).toEqual({ backend: 'claude', headless: true })
    expect(processModelToBackendHeadless('claude-pty', true)).toEqual({ backend: 'claude', headless: false })
  })

  test('round-trips through deriveClaudeTransport', () => {
    const models: ClaudeTransport[] = ['claude-pty', 'claude-headless', 'claude-daemon']
    for (const pm of models) {
      const { backend, headless } = processModelToBackendHeadless(pm, true)
      expect(deriveClaudeTransport(backend, headless)).toBe(pm)
    }
  })
})

/**
 * Unit tests for the daemon-launch pure helpers -- validation + spawn-request
 * shaping for the spawn dialog's three daemon modes (NEW / RESUME / ATTACH).
 */

import { describe, expect, test } from 'vitest'
import {
  blankDaemonForm,
  buildDaemonSpawnFields,
  type DaemonModeFormValue,
  validateDaemonAttach,
  validateDaemonModeForm,
} from './daemon-launch'

function form(overrides: Partial<DaemonModeFormValue> = {}): DaemonModeFormValue {
  return { ...blankDaemonForm(), ...overrides }
}

describe('blankDaemonForm', () => {
  test('returns an all-empty form', () => {
    const f = blankDaemonForm()
    expect(f.prompt).toBe('')
    expect(f.model).toBe('')
    expect(f.resumeSessionId).toBe('')
    expect(f.settingsPath).toBe('')
  })
})

describe('validateDaemonModeForm -- NEW', () => {
  test('requires a non-empty prompt', () => {
    expect(validateDaemonModeForm('new', form())).toContain('Prompt is required for a new daemon worker')
    expect(validateDaemonModeForm('new', form({ prompt: '   ' }))).toContain(
      'Prompt is required for a new daemon worker',
    )
  })

  test('passes with a prompt and no other config', () => {
    expect(validateDaemonModeForm('new', form({ prompt: 'do the thing' }))).toEqual([])
  })

  test('flags a non-absolute settings path', () => {
    const errs = validateDaemonModeForm('new', form({ prompt: 'go', settingsPath: 'relative/settings.json' }))
    expect(errs).toContain('Settings path must be absolute (start with /)')
  })

  test('flags a non-absolute mcp config path', () => {
    const errs = validateDaemonModeForm('new', form({ prompt: 'go', mcpConfigPath: 'mcp.json' }))
    expect(errs).toContain('MCP config path must be absolute (start with /)')
  })

  test('accepts absolute settings + mcp paths', () => {
    const errs = validateDaemonModeForm(
      'new',
      form({ prompt: 'go', settingsPath: '/abs/settings.json', mcpConfigPath: '/abs/mcp.json' }),
    )
    expect(errs).toEqual([])
  })

  test('surfaces env parse errors', () => {
    const errs = validateDaemonModeForm('new', form({ prompt: 'go', envText: 'NOT_AN_ASSIGNMENT' }))
    expect(errs.some(e => e.includes('missing KEY=value'))).toBe(true)
  })
})

describe('validateDaemonModeForm -- RESUME', () => {
  test('requires a resume session id', () => {
    expect(validateDaemonModeForm('resume', form())).toContain('Resume session id is required')
  })

  test('does NOT require a prompt for resume', () => {
    expect(validateDaemonModeForm('resume', form({ resumeSessionId: 'ccs_abc' }))).toEqual([])
  })
})

describe('validateDaemonAttach', () => {
  test('requires a selection', () => {
    expect(validateDaemonAttach(undefined)).toEqual(['Select a daemon worker to attach to'])
    expect(validateDaemonAttach('')).toEqual(['Select a daemon worker to attach to'])
  })

  test('rejects a malformed short id', () => {
    expect(validateDaemonAttach('XYZ')).toEqual(['Selected worker has an invalid short id'])
    expect(validateDaemonAttach('aeb185f')).toEqual(['Selected worker has an invalid short id'])
  })

  test('accepts an 8-hex short id', () => {
    expect(validateDaemonAttach('aeb185f9')).toEqual([])
  })
})

describe('buildDaemonSpawnFields -- NEW', () => {
  test('shapes a new-mode request with prompt + config injection', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'new',
      form: form({
        prompt: 'build it',
        model: 'claude-opus-4-7',
        appendSystemPrompt: 'be terse',
        envText: 'FOO=bar',
        settingsPath: '/s.json',
        mcpConfigPath: '/m.json',
        worktreeName: 'feature-x',
      }),
    })
    expect(fields.backend).toBe('daemon')
    expect(fields.daemonMode).toBe('new')
    expect(fields.prompt).toBe('build it')
    expect(fields.model).toBe('claude-opus-4-7')
    expect(fields.appendSystemPrompt).toBe('be terse')
    expect(fields.env).toEqual({ FOO: 'bar' })
    expect(fields.daemonSettingsPath).toBe('/s.json')
    expect(fields.daemonMcpConfigPath).toBe('/m.json')
    expect(fields.worktree).toBe('feature-x')
    expect(fields.daemonResumeSessionId).toBeUndefined()
    expect(fields.daemonAttachShort).toBeUndefined()
  })

  test('omits empty optional fields', () => {
    const fields = buildDaemonSpawnFields({ mode: 'new', form: form({ prompt: 'go' }) })
    expect(fields.prompt).toBe('go')
    expect(fields.model).toBeUndefined()
    expect(fields.env).toBeUndefined()
    expect(fields.daemonSettingsPath).toBeUndefined()
    expect(fields.worktree).toBeUndefined()
  })
})

describe('buildDaemonSpawnFields -- RESUME', () => {
  test('forwards daemonResumeSessionId and keeps the prompt optional', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'resume',
      form: form({ resumeSessionId: 'ccs_prior', prompt: '' }),
    })
    expect(fields.daemonMode).toBe('resume')
    expect(fields.daemonResumeSessionId).toBe('ccs_prior')
    expect(fields.prompt).toBeUndefined()
  })

  test('carries a first-turn prompt when one is given', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'resume',
      form: form({ resumeSessionId: 'ccs_prior', prompt: 'continue' }),
    })
    expect(fields.prompt).toBe('continue')
  })
})

describe('buildDaemonSpawnFields -- ATTACH', () => {
  test('forwards only the attach short -- no prompt, no config injection', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'attach',
      form: form({ prompt: 'ignored', settingsPath: '/ignored.json' }),
      attachShort: 'aeb185f9',
    })
    expect(fields.backend).toBe('daemon')
    expect(fields.daemonMode).toBe('attach')
    expect(fields.daemonAttachShort).toBe('aeb185f9')
    expect(fields.prompt).toBeUndefined()
    expect(fields.daemonSettingsPath).toBeUndefined()
    expect(fields.daemonMcpConfigPath).toBeUndefined()
    expect(fields.env).toBeUndefined()
    expect(fields.daemonResumeSessionId).toBeUndefined()
  })
})

describe('buildDaemonSpawnFields -- transport-reframe DUAL-WRITE', () => {
  test('NEW writes transport=claude-daemon + a transportMeta bag mirroring the flat fields', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'new',
      form: form({
        prompt: 'build it',
        appendSystemPrompt: 'be terse',
        settingsPath: '/s.json',
        mcpConfigPath: '/m.json',
      }),
    })
    expect(fields.transport).toBe('claude-daemon')
    expect(fields.transportMeta).toEqual({
      mode: 'new',
      settingsPath: '/s.json',
      mcpConfigPath: '/m.json',
      appendSystemPrompt: 'be terse',
    })
  })

  test('NEW omits empty optional keys from the transportMeta bag', () => {
    const fields = buildDaemonSpawnFields({ mode: 'new', form: form({ prompt: 'go' }) })
    expect(fields.transport).toBe('claude-daemon')
    expect(fields.transportMeta).toEqual({ mode: 'new' })
  })

  test('RESUME carries resumeSessionId in the transportMeta bag', () => {
    const fields = buildDaemonSpawnFields({ mode: 'resume', form: form({ resumeSessionId: 'ccs_prior' }) })
    expect(fields.transportMeta).toEqual({ mode: 'resume', resumeSessionId: 'ccs_prior' })
  })

  test('ATTACH transportMeta is mode + attachShort only (no forbidden config keys)', () => {
    const fields = buildDaemonSpawnFields({
      mode: 'attach',
      form: form({ prompt: 'ignored', settingsPath: '/ignored.json' }),
      attachShort: 'aeb185f9',
    })
    expect(fields.transport).toBe('claude-daemon')
    expect(fields.transportMeta).toEqual({ mode: 'attach', attachShort: 'aeb185f9' })
  })
})

/**
 * spawn-dialog-apply -- profile <-> spawn-dialog form bridge.
 *
 * Phase F focus: the daemon launch round-trip. A daemon launch saved as a
 * profile must restore cleanly into the dialog's daemon state, and the
 * per-launch-only fields (prompt / resume session id / attach short) must
 * never be persisted.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { describe, expect, test, vi } from 'vitest'
import { blankDaemonForm, type DaemonModeFormValue } from '@/components/spawn-dialog/daemon-launch'
import {
  applyProfileToForm,
  type FormSnapshotInput,
  formSnapshotToProfileSpawn,
  type SpawnFormSetters,
} from './spawn-dialog-apply'

function snap(overrides: Partial<FormSnapshotInput> = {}): FormSnapshotInput {
  return {
    model: '',
    effort: '',
    agent: '',
    permissionMode: '',
    autocompactPct: '',
    maxBudgetUsd: '',
    headless: true,
    bare: false,
    repl: false,
    includePartialMessages: true,
    backend: 'claude',
    envText: '',
    ...overrides,
  }
}

function daemonForm(overrides: Partial<DaemonModeFormValue> = {}): DaemonModeFormValue {
  return { ...blankDaemonForm(), ...overrides }
}

/** A full set of setter spies for applyProfileToForm. */
function setterSpies() {
  return {
    setHeadless: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setAgent: vi.fn(),
    setBare: vi.fn(),
    setRepl: vi.fn(),
    setPermissionMode: vi.fn(),
    setAutocompactPct: vi.fn(),
    setMaxBudgetUsd: vi.fn(),
    setIncludePartialMessages: vi.fn(),
    setBackend: vi.fn(),
    setEnvText: vi.fn(),
    setOpenCodeModel: vi.fn(),
    setOpenCodeToolPermission: vi.fn(),
    setDaemonMode: vi.fn(),
    setDaemonForm: vi.fn(),
    setSentinelProfile: vi.fn(),
    setSentinelPool: vi.fn(),
  } satisfies Required<SpawnFormSetters>
}

function profile(spawn: LaunchProfile['spawn']): LaunchProfile {
  return { id: 'lp_test', name: 'Test', spawn, createdAt: 0, updatedAt: 0 }
}

describe('formSnapshotToProfileSpawn -- daemon backend', () => {
  test('NEW: captures mode, model, config paths, append prompt, env, worktree', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        backend: 'daemon',
        daemonMode: 'new',
        daemonForm: daemonForm({
          model: 'claude-opus-4-7',
          appendSystemPrompt: 'be terse',
          envText: 'FOO=bar\nBAZ=qux',
          settingsPath: '/etc/claude/settings.json',
          mcpConfigPath: '/etc/claude/mcp.json',
          worktreeName: 'feature-x',
        }),
      }),
    )
    expect(spawn.backend).toBe('daemon')
    expect(spawn.daemonMode).toBe('new')
    expect(spawn.model).toBe('claude-opus-4-7')
    expect(spawn.appendSystemPrompt).toBe('be terse')
    expect(spawn.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(spawn.daemonSettingsPath).toBe('/etc/claude/settings.json')
    expect(spawn.daemonMcpConfigPath).toBe('/etc/claude/mcp.json')
    expect(spawn.worktree).toBe('feature-x')
  })

  test('RESUME mode is preserved', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({ backend: 'daemon', daemonMode: 'resume', daemonForm: daemonForm() }),
    )
    expect(spawn.daemonMode).toBe('resume')
  })

  test('ATTACH collapses to NEW -- a profile cannot pin an ephemeral attach target', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({ backend: 'daemon', daemonMode: 'attach', daemonForm: daemonForm() }),
    )
    expect(spawn.daemonMode).toBe('new')
  })
})

describe('formSnapshotToProfileSpawn -- daemon: omitted / per-launch-only fields', () => {
  test('per-launch-only fields (prompt, resume session id) are NOT persisted', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        backend: 'daemon',
        daemonMode: 'resume',
        daemonForm: daemonForm({ prompt: 'do not save me', resumeSessionId: 'ccs_ephemeral' }),
      }),
    )
    expect((spawn as Record<string, unknown>).prompt).toBeUndefined()
    expect((spawn as Record<string, unknown>).daemonResumeSessionId).toBeUndefined()
    expect((spawn as Record<string, unknown>).daemonAttachShort).toBeUndefined()
  })

  test('empty optional fields are omitted', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'daemon', daemonMode: 'new', daemonForm: daemonForm() }))
    expect(spawn).toEqual({ backend: 'daemon', daemonMode: 'new' })
  })

  test('does not leak the generic claude form fields into a daemon profile', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        backend: 'daemon',
        daemonMode: 'new',
        daemonForm: daemonForm({ prompt: 'go' }),
        // Generic claude state left at non-defaults -- must be ignored.
        effort: 'high',
        permissionMode: 'acceptEdits',
        maxBudgetUsd: '5',
      }),
    )
    expect(spawn.effort).toBeUndefined()
    expect(spawn.permissionMode).toBeUndefined()
    expect(spawn.maxBudgetUsd).toBeUndefined()
  })

  test('missing daemonMode/daemonForm defaults to a NEW empty profile', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'daemon' }))
    expect(spawn).toEqual({ backend: 'daemon', daemonMode: 'new' })
  })
})

describe('applyProfileToForm -- daemon backend', () => {
  test('restores backend, mode and the config form', () => {
    const setters = setterSpies()
    applyProfileToForm(
      profile({
        backend: 'daemon',
        daemonMode: 'resume',
        model: 'claude-haiku-4-5',
        appendSystemPrompt: 'be careful',
        daemonSettingsPath: '/s.json',
        daemonMcpConfigPath: '/m.json',
        worktree: 'wt-1',
        env: { A: '1' },
      }),
      setters,
    )
    expect(setters.setBackend).toHaveBeenCalledWith('daemon')
    expect(setters.setDaemonMode).toHaveBeenCalledWith('resume')
    expect(setters.setDaemonForm).toHaveBeenCalledTimes(1)
    const form = setters.setDaemonForm.mock.calls[0]![0] as DaemonModeFormValue
    expect(form.model).toBe('claude-haiku-4-5')
    expect(form.appendSystemPrompt).toBe('be careful')
    expect(form.settingsPath).toBe('/s.json')
    expect(form.mcpConfigPath).toBe('/m.json')
    expect(form.worktreeName).toBe('wt-1')
    expect(form.envText).toBe('A=1')
    // Per-launch-only fields are blank -- the user supplies them in the dialog.
    expect(form.prompt).toBe('')
    expect(form.resumeSessionId).toBe('')
  })

  test('a daemon profile does NOT touch the generic claude setters', () => {
    const setters = setterSpies()
    applyProfileToForm(profile({ backend: 'daemon', daemonMode: 'new' }), setters)
    expect(setters.setHeadless).not.toHaveBeenCalled()
    expect(setters.setEffort).not.toHaveBeenCalled()
    expect(setters.setPermissionMode).not.toHaveBeenCalled()
  })

  test('defaults daemonMode to new when the profile omits it', () => {
    const setters = setterSpies()
    applyProfileToForm(profile({ backend: 'daemon' }), setters)
    expect(setters.setDaemonMode).toHaveBeenCalledWith('new')
  })

  test('detects a transport-only daemon profile (no backend) and restores daemon state', () => {
    const setters = setterSpies()
    applyProfileToForm(profile({ transport: 'claude-daemon', daemonMode: 'resume' }), setters)
    expect(setters.setBackend).toHaveBeenCalledWith('daemon')
    expect(setters.setDaemonMode).toHaveBeenCalledWith('resume')
    // Generic claude setters stay untouched -- daemon owns a separate form.
    expect(setters.setEffort).not.toHaveBeenCalled()
  })
})

describe('daemon profile round-trip -- snapshot -> profile -> form', () => {
  test('config survives the full round-trip', () => {
    const original = daemonForm({
      model: 'claude-opus-4-7',
      appendSystemPrompt: 'terse',
      envText: 'K=v',
      settingsPath: '/abs/settings.json',
      mcpConfigPath: '/abs/mcp.json',
      worktreeName: 'branch-y',
    })
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'daemon', daemonMode: 'resume', daemonForm: original }))

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    const restored = setters.setDaemonForm.mock.calls[0]![0] as DaemonModeFormValue

    expect(setters.setDaemonMode).toHaveBeenCalledWith('resume')
    expect(restored.model).toBe(original.model)
    expect(restored.appendSystemPrompt).toBe(original.appendSystemPrompt)
    expect(restored.envText).toBe(original.envText)
    expect(restored.settingsPath).toBe(original.settingsPath)
    expect(restored.mcpConfigPath).toBe(original.mcpConfigPath)
    expect(restored.worktreeName).toBe(original.worktreeName)
  })
})

describe('formSnapshotToProfileSpawn -- non-daemon unaffected', () => {
  test('claude backend still snapshots the generic fields', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'claude', model: 'claude-haiku-4-5', effort: 'low' }))
    expect(spawn.model).toBe('claude-haiku-4-5')
    expect(spawn.effort).toBe('low')
    expect(spawn.daemonMode).toBeUndefined()
  })
})

describe('sentinel-profile intent round-trip (Phase 6)', () => {
  test('claude backend persists a Fixed profile name and restores it', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'claude', sentinelProfile: 'work' }))
    expect(spawn.profile).toBe('work')

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    expect(setters.setSentinelProfile).toHaveBeenCalledWith('work')
  })

  test('claude backend persists a pool name and restores it', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'claude', sentinelPool: 'work' }))
    expect(spawn.pool).toBe('work')

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    expect(setters.setSentinelPool).toHaveBeenCalledWith('work')
  })

  test('empty sentinel-profile is omitted from the saved profile', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ backend: 'claude', sentinelProfile: '' }))
    expect(spawn.profile).toBeUndefined()

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    // Missing field restores as empty string so the dialog leaves the
    // sentinel to pick.
    expect(setters.setSentinelProfile).toHaveBeenCalledWith('')
  })

  test('daemon backend also round-trips the sentinel-profile intent', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({ backend: 'daemon', daemonMode: 'new', daemonForm: daemonForm(), sentinelProfile: 'work' }),
    )
    expect(spawn.profile).toBe('work')

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    expect(setters.setSentinelProfile).toHaveBeenCalledWith('work')
  })
})

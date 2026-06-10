/**
 * spawn-dialog-apply -- profile <-> spawn-dialog form bridge.
 *
 * Transport reframe (Phase 6): a daemon launch profile is `backend:'claude'` +
 * `transport:'claude-daemon'`, always NEW-mode, with the injected config paths
 * on the web-readable `settingsPath` / `mcpConfigPath` fields. Per-launch-only
 * input (prompt / resume session id / attach short) is never persisted.
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
    advisor: '',
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
    setAdvisor: vi.fn(),
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
    setIsDaemon: vi.fn(),
    setDaemonMode: vi.fn(),
    setDaemonForm: vi.fn(),
    setSentinelProfile: vi.fn(),
    setSentinelPool: vi.fn(),
  } satisfies Required<SpawnFormSetters>
}

function profile(spawn: LaunchProfile['spawn']): LaunchProfile {
  return { id: 'lp_test', name: 'Test', spawn, createdAt: 0, updatedAt: 0 }
}

describe('formSnapshotToProfileSpawn -- daemon transport', () => {
  test('captures the transport + model + config paths + append prompt + env + worktree', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        isDaemon: true,
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
    // The daemon is a transport, not a backend.
    expect(spawn.backend).toBe('claude')
    expect(spawn.transport).toBe('claude-daemon')
    expect(spawn.model).toBe('claude-opus-4-7')
    expect(spawn.appendSystemPrompt).toBe('be terse')
    expect(spawn.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(spawn.settingsPath).toBe('/etc/claude/settings.json')
    expect(spawn.mcpConfigPath).toBe('/etc/claude/mcp.json')
    expect(spawn.worktree).toBe('feature-x')
    // No flat daemon* fields persist anymore.
    expect('daemonMode' in spawn).toBe(false)
    expect('daemonSettingsPath' in spawn).toBe(false)
  })

  test('per-launch-only fields (prompt, resume session id) are NOT persisted', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        isDaemon: true,
        daemonForm: daemonForm({ prompt: 'do not save me', resumeSessionId: 'ccs_ephemeral' }),
      }),
    )
    expect((spawn as Record<string, unknown>).prompt).toBeUndefined()
    expect((spawn as Record<string, unknown>).resumeSessionId).toBeUndefined()
  })

  test('empty optional fields are omitted -- a daemon profile is transport-only', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ isDaemon: true, daemonForm: daemonForm() }))
    expect(spawn).toEqual({ backend: 'claude', transport: 'claude-daemon' })
  })

  test('does not leak the generic claude form fields into a daemon profile', () => {
    const spawn = formSnapshotToProfileSpawn(
      snap({
        isDaemon: true,
        daemonForm: daemonForm({ prompt: 'go' }),
        effort: 'high',
        permissionMode: 'acceptEdits',
        maxBudgetUsd: '5',
      }),
    )
    expect(spawn.effort).toBeUndefined()
    expect(spawn.permissionMode).toBeUndefined()
    expect(spawn.maxBudgetUsd).toBeUndefined()
  })

  test('missing daemonForm defaults to a transport-only profile', () => {
    const spawn = formSnapshotToProfileSpawn(snap({ isDaemon: true }))
    expect(spawn).toEqual({ backend: 'claude', transport: 'claude-daemon' })
  })
})

describe('applyProfileToForm -- daemon transport', () => {
  test('restores the daemon state + config form from a transport-shaped profile', () => {
    const setters = setterSpies()
    applyProfileToForm(
      profile({
        backend: 'claude',
        transport: 'claude-daemon',
        model: 'claude-haiku-4-5',
        appendSystemPrompt: 'be careful',
        settingsPath: '/s.json',
        mcpConfigPath: '/m.json',
        worktree: 'wt-1',
        env: { A: '1' },
      }),
      setters,
    )
    expect(setters.setBackend).toHaveBeenCalledWith('claude')
    expect(setters.setIsDaemon).toHaveBeenCalledWith(true)
    // A daemon profile is always NEW-mode.
    expect(setters.setDaemonMode).toHaveBeenCalledWith('new')
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
    applyProfileToForm(profile({ backend: 'claude', transport: 'claude-daemon' }), setters)
    expect(setters.setHeadless).not.toHaveBeenCalled()
    expect(setters.setEffort).not.toHaveBeenCalled()
    expect(setters.setPermissionMode).not.toHaveBeenCalled()
  })

  test('a non-daemon profile clears the daemon flag', () => {
    const setters = setterSpies()
    applyProfileToForm(profile({ backend: 'claude' }), setters)
    expect(setters.setIsDaemon).toHaveBeenCalledWith(false)
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
    const spawn = formSnapshotToProfileSpawn(snap({ isDaemon: true, daemonForm: original }))

    const setters = setterSpies()
    applyProfileToForm(profile(spawn), setters)
    const restored = setters.setDaemonForm.mock.calls[0]![0] as DaemonModeFormValue

    expect(setters.setIsDaemon).toHaveBeenCalledWith(true)
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
    expect(spawn.transport).toBeUndefined()
  })
})

/** Assert a spawn snapshot persists `profile='work'` and restores it through the
 *  form -- the round-trip both the claude and daemon cases share. */
function expectSentinelProfileRoundTrips(spawn: ReturnType<typeof formSnapshotToProfileSpawn>) {
  expect(spawn.profile).toBe('work')
  const setters = setterSpies()
  applyProfileToForm(profile(spawn), setters)
  expect(setters.setSentinelProfile).toHaveBeenCalledWith('work')
}

describe('sentinel-profile intent round-trip', () => {
  test('claude backend persists a Fixed profile name and restores it', () => {
    expectSentinelProfileRoundTrips(formSnapshotToProfileSpawn(snap({ backend: 'claude', sentinelProfile: 'work' })))
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
    expect(setters.setSentinelProfile).toHaveBeenCalledWith('')
  })

  test('a daemon profile also round-trips the sentinel-profile intent', () => {
    expectSentinelProfileRoundTrips(
      formSnapshotToProfileSpawn(snap({ isDaemon: true, daemonForm: daemonForm(), sentinelProfile: 'work' })),
    )
  })
})

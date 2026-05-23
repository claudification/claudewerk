import type { LaunchProfile } from '@shared/launch-profile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSpawnRequest, runProfile } from './run-profile'

vi.mock('@/components/spawn-dialog', () => ({ openSpawnDialog: vi.fn() }))
vi.mock('@/hooks/use-spawn', () => ({ sendSpawnRequest: vi.fn(async () => ({ ok: true, conversationId: 'conv_x' })) }))

import { openSpawnDialog } from '@/components/spawn-dialog'
import { sendSpawnRequest } from '@/hooks/use-spawn'

const openSpawnDialogMock = vi.mocked(openSpawnDialog)
const sendSpawnRequestMock = vi.mocked(sendSpawnRequest)

afterEach(() => {
  openSpawnDialogMock.mockClear()
  sendSpawnRequestMock.mockClear()
})

function p(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: 'lp_x',
    name: 'X',
    spawn: { backend: 'claude' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildSpawnRequest', () => {
  it('merges profile.spawn onto cwd+sentinel', () => {
    const req = buildSpawnRequest(
      p({ spawn: { backend: 'claude', model: 'claude-haiku-4-5', effort: 'low' } }),
      '/tmp/cwd',
      'tower',
    )
    expect(req.cwd).toBe('/tmp/cwd')
    expect(req.sentinel).toBe('tower')
    expect(req.model).toBe('claude-haiku-4-5')
    expect(req.effort).toBe('low')
    expect(req.backend).toBe('claude')
  })

  it('respects appendSystemPrompt from the profile', () => {
    const req = buildSpawnRequest(p({ spawn: { backend: 'claude', appendSystemPrompt: 'be terse' } }), '/x', undefined)
    expect(req.appendSystemPrompt).toBe('be terse')
  })

  it('passes through chord and immediate-irrelevant fields (they are not in SpawnRequest)', () => {
    const req = buildSpawnRequest(p({ chord: 'a', immediate: false }), '/x', undefined)
    expect((req as unknown as { chord?: string }).chord).toBeUndefined()
    expect((req as unknown as { immediate?: boolean }).immediate).toBeUndefined()
  })

  it('carries daemon launch fields (transport + injected paths) straight through', () => {
    const req = buildSpawnRequest(
      p({ spawn: { backend: 'claude', transport: 'claude-daemon', settingsPath: '/s.json' } }),
      '/x',
      undefined,
    )
    expect(req.backend).toBe('claude')
    expect(req.transport).toBe('claude-daemon')
    expect(req.settingsPath).toBe('/s.json')
  })
})

describe('runProfile -- daemon profiles always open the dialog', () => {
  it('a daemon profile opens the spawn dialog pre-filled, even when immediate', async () => {
    const profile = p({
      id: 'lp_daemon',
      spawn: { backend: 'claude', transport: 'claude-daemon' },
      immediate: true,
    })
    await runProfile(profile, { cwd: '/tmp/work' }, { sentinels: [] })
    expect(sendSpawnRequestMock).not.toHaveBeenCalled()
    expect(openSpawnDialogMock).toHaveBeenCalledTimes(1)
    expect(openSpawnDialogMock.mock.calls[0]![0]).toMatchObject({ path: '/tmp/work', profileId: 'lp_daemon' })
  })

  it('a non-immediate claude profile opens the dialog WITHOUT a profileId (historical behavior)', async () => {
    const profile = p({ spawn: { backend: 'claude' }, immediate: false })
    await runProfile(profile, { cwd: '/tmp/work' }, { sentinels: [] })
    expect(openSpawnDialogMock).toHaveBeenCalledTimes(1)
    expect(openSpawnDialogMock.mock.calls[0]![0]!.profileId).toBeUndefined()
  })

  it('an immediate claude profile still fires straight to the broker', async () => {
    const profile = p({ spawn: { backend: 'claude' }, immediate: true })
    await runProfile(profile, { cwd: '/tmp/work' }, { sentinels: [] })
    expect(openSpawnDialogMock).not.toHaveBeenCalled()
    expect(sendSpawnRequestMock).toHaveBeenCalledTimes(1)
  })

  it('a daemon profile with no resolvable cwd is blocked before opening the dialog', async () => {
    const profile = p({ spawn: { backend: 'claude', transport: 'claude-daemon' }, immediate: true })
    const toasts: string[] = []
    await runProfile(profile, {}, { sentinels: [], onToast: t => toasts.push(t.variant) })
    expect(openSpawnDialogMock).not.toHaveBeenCalled()
    expect(toasts).toEqual(['blocked'])
  })
})

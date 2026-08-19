/**
 * @vitest-environment node
 */
/**
 * The revive dialog's opening state.
 *
 * The chain has to match the server handler's (`reviveConversation`), because
 * anything the dialog shows but does not send is a lie about what will happen.
 */

import { describe, expect, test } from 'vitest'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import type { Conversation, ProjectSettingsMap } from '@/lib/types'
import type { ProfileUsageEntry } from '../spawn-dialog/profile-usage'
import { computeReviveDefaults, hostSentinelOf, originalProfileOf } from './revive-defaults'

const PROJECT = 'claude://default/Users/jonas/projects/repo'

function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: 'conv_1', project: PROJECT, ...over } as Conversation
}

function input(over: Partial<Parameters<typeof computeReviveDefaults>[0]> = {}) {
  return {
    conversation: conv(),
    projectSettings: {} as ProjectSettingsMap,
    globalSettings: {} as Record<string, unknown>,
    sentinels: [] as SentinelStatusInfo[],
    profileUsage: {} as Record<string, ProfileUsageEntry>,
    ...over,
  }
}

describe('computeReviveDefaults', () => {
  test('launch config beats project settings, which beat global', () => {
    const projectSettings = { [PROJECT]: { defaultModel: 'sonnet', defaultEffort: 'low' } } as ProjectSettingsMap
    const globalSettings = { defaultModel: 'haiku', defaultEffort: 'high' }

    const fromLaunch = computeReviveDefaults(
      input({
        conversation: conv({ launchConfig: { headless: false, model: 'opus', effort: 'max' } }),
        projectSettings,
        globalSettings,
      }),
    )
    expect(fromLaunch).toMatchObject({ model: 'opus', effort: 'max', headless: false })

    const fromProject = computeReviveDefaults(input({ projectSettings, globalSettings }))
    expect(fromProject).toMatchObject({ model: 'sonnet', effort: 'low' })

    const fromGlobal = computeReviveDefaults(input({ globalSettings }))
    expect(fromGlobal).toMatchObject({ model: 'haiku', effort: 'high' })
  })

  test('defaults to headless when nothing in the chain says otherwise', () => {
    expect(computeReviveDefaults(input()).headless).toBe(true)
    expect(computeReviveDefaults(input({ globalSettings: { defaultLaunchMode: 'pty' } })).headless).toBe(false)
  })

  // 'default' means "pass no --effort flag", which is not the same as the
  // literal string reaching the sentinel.
  test('normalises the sentinel effort value to empty', () => {
    expect(computeReviveDefaults(input({ globalSettings: { defaultEffort: 'default' } })).effort).toBe('')
  })

  test('pins to the original profile', () => {
    const defaults = computeReviveDefaults(input({ conversation: conv({ resolvedProfile: 'work' }) }))
    expect(defaults.profile).toBe('work')
  })

  // Over 85% on the original's worst window, revive lands on a fresher account
  // instead of a rate-limited one.
  test('auto-unpins off a profile that is out of headroom', () => {
    const sentinel = {
      sentinelId: 'snt_1',
      alias: 'default',
      connected: true,
      profiles: [{ name: 'work' }, { name: 'personal' }],
    } as SentinelStatusInfo
    const usage = {
      a: { sentinelId: 'snt_1', profile: 'work', fiveHour: { usedPercent: 97 }, sevenDay: { usedPercent: 40 } },
      b: { sentinelId: 'snt_1', profile: 'personal', fiveHour: { usedPercent: 5 }, sevenDay: { usedPercent: 9 } },
    } as unknown as Record<string, ProfileUsageEntry>

    const defaults = computeReviveDefaults(
      input({ conversation: conv({ resolvedProfile: 'work' }), sentinels: [sentinel], profileUsage: usage }),
    )
    expect(defaults.profile).toBe('personal')
  })
})

describe('originalProfileOf', () => {
  test('an unset profile means the implicit default', () => {
    expect(originalProfileOf(conv())).toBe('default')
    expect(originalProfileOf(undefined)).toBe('default')
    expect(originalProfileOf(conv({ resolvedProfile: 'work' }))).toBe('work')
  })
})

describe('hostSentinelOf', () => {
  const sentinels = [
    { alias: 'Default', sentinelId: 'snt_1' },
    { alias: 'laptop', sentinelId: 'snt_2' },
  ]

  test('matches the host alias case-insensitively, defaulting to the default sentinel', () => {
    expect(hostSentinelOf(conv({ hostSentinelAlias: 'LAPTOP' }), sentinels)?.sentinelId).toBe('snt_2')
    expect(hostSentinelOf(conv(), sentinels)?.sentinelId).toBe('snt_1')
    expect(hostSentinelOf(conv({ hostSentinelAlias: 'gone' }), sentinels)).toBeUndefined()
  })
})

/**
 * What the revive dialog opens with.
 *
 * The resolution chain mirrors the server handler (`reviveConversation` in
 * `src/broker/handlers/control-panel-actions.ts`): stored launch config beats
 * project settings, which beat global settings. Pure so the chain can be
 * asserted without mounting a dialog.
 */

import { DEFAULT_SENTINEL_NAME, projectIdentityKey } from '@shared/project-uri'
import { DEFAULT_PROFILE_NAME } from '@shared/spawn-schema'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import type { Conversation, ProjectSettingsMap } from '@/lib/types'
import type { ProfileUsageEntry } from '../spawn-dialog/profile-usage'
import { buildProfileUsageMap, resolveReviveDefaultProfile } from '../spawn-dialog/profile-usage'

/** 85% auto-unpin threshold. Over this on the original profile's worst usage
 *  window, the revive dialog pre-selects a fresher profile instead of pinning. */
const UNPIN_USAGE_PCT = 85

export interface ReviveDefaults {
  headless: boolean
  model: string
  effort: string
  profile: string
}

export interface ReviveDefaultsInput {
  conversation: Conversation | undefined
  projectSettings: ProjectSettingsMap
  globalSettings: Record<string, unknown>
  sentinels: SentinelStatusInfo[]
  profileUsage: Record<string, ProfileUsageEntry>
}

/** The profile a conversation was resolved onto. Unset means the implicit one. */
export function originalProfileOf(conversation: Conversation | undefined): string {
  return conversation?.resolvedProfile || DEFAULT_PROFILE_NAME
}

/** The sentinel hosting a conversation, matched on its (case-insensitive) alias. */
export function hostSentinelOf<T extends { alias: string }>(
  conversation: Conversation | undefined,
  sentinels: T[],
): T | undefined {
  const alias = (conversation?.hostSentinelAlias || DEFAULT_SENTINEL_NAME).toLowerCase()
  return sentinels.find(s => s.alias.toLowerCase() === alias)
}

/**
 * First non-empty of launch config > project settings > global settings.
 *
 * One helper for all three fields, because the chain is the contract -- writing
 * it out per field is how one of them quietly ends up in a different order.
 */
function resolveChain(...candidates: (string | undefined)[]): string {
  return candidates.find(v => !!v) ?? ''
}

/**
 * PIN to the conversation's original profile, UNLESS that profile is near its
 * rate-limit cap -- then auto-unpin to the freshest alternative so a desperate
 * revive lands on a usable account. Profile-Env Boundary: NAMES + usage only.
 */
function resolveProfile(input: ReviveDefaultsInput): string {
  const sentinel = hostSentinelOf(input.conversation, input.sentinels)
  const usageByName = buildProfileUsageMap(sentinel?.sentinelId, input.profileUsage)
  return resolveReviveDefaultProfile(
    originalProfileOf(input.conversation),
    sentinel?.profiles ?? [],
    usageByName,
    UNPIN_USAGE_PCT,
  )
}

export function computeReviveDefaults(input: ReviveDefaultsInput): ReviveDefaults {
  const { conversation, projectSettings, globalSettings } = input
  const ps = conversation ? projectSettings[projectIdentityKey(conversation.project)] : undefined
  const lc = conversation?.launchConfig

  const lcMode = lc && (lc.headless ? 'headless' : 'pty')
  const mode = resolveChain(lcMode || undefined, ps?.defaultLaunchMode, globalSettings.defaultLaunchMode as string)
  const effort = resolveChain(lc?.effort, ps?.defaultEffort, globalSettings.defaultEffort as string)

  return {
    // Headless unless something in the chain explicitly says PTY.
    headless: mode !== 'pty',
    model: resolveChain(lc?.model, ps?.defaultModel, globalSettings.defaultModel as string),
    // 'default' means "pass no --effort flag" -- not a value to send on.
    effort: effort === 'default' ? '' : effort,
    profile: resolveProfile(input),
  }
}

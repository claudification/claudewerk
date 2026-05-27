/**
 * Shared resolution of a sentinel profile's DISPLAY metadata for the UI.
 *
 * A conversation carries only the resolved profile NAME
 * (`Conversation.resolvedProfile`, e.g. `work`). The human-friendly `label`,
 * `color`, and `showLabel` live on the live sentinel report
 * (`SentinelStatusInfo.profiles`). These helpers join the two so every surface
 * renders the operator's label instead of the raw key, falling back to the
 * name when no label (or no sentinel report) is available.
 *
 * PROFILE-ENV BOUNDARY: profiles carry NAME + display only -- never configDir
 * or env. These helpers stay on the broker-safe side of that line.
 */

import type { SentinelProfileInfo } from '@shared/protocol'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'

/** Look up a profile's display metadata from the live sentinel report. Returns
 *  undefined when the sentinel alias or profile name isn't known (sentinel
 *  offline, single-profile install, stale report). */
export function findProfileMeta(
  sentinels: SentinelStatusInfo[],
  hostSentinelAlias: string | undefined,
  profileName: string,
): SentinelProfileInfo | undefined {
  if (!hostSentinelAlias) return undefined
  const alias = hostSentinelAlias.toLowerCase()
  const match = sentinels.find(s => s.alias.toLowerCase() === alias)
  return match?.profiles?.find(p => p.name === profileName)
}

/** Visible display name for a profile: the operator's `label` when set, else
 *  the raw profile NAME (`default` / `work`). */
export function profileDisplayName(meta: SentinelProfileInfo | undefined, profileName: string): string {
  return meta?.label ?? profileName
}

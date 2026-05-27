/**
 * Sentinel-profile badge for the conversation list / sidebar.
 *
 * Reads the RESOLVED profile name directly from `conversation.resolvedProfile`
 * (what the sentinel picked at spawn time) and renders a small inline badge
 * tinted by the profile's `color`. For conversations launched via Pool, also
 * renders a shuffle icon -- the "intent indicator" read from
 * `launchConfig.sentinelProfile.kind === 'pool'`.
 *
 * INTENT vs RESOLVED: the badge text is the RESOLVED name. The shuffle icon
 * surfaces the user's original intent so a conversation picked from a pool is
 * visually distinct from one pinned to a specific profile.
 *
 * PROFILE-ENV BOUNDARY: this component never touches configDir / env --
 * sentinel.profiles only carries name / label / color / pooled / authed.
 */

import type { LaunchConfig } from '@shared/protocol'
import { Shuffle } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { findProfileMeta, profileDisplayName } from '@/lib/profile-display'

interface SentinelProfileBadgeProps {
  /** Resolved profile NAME the sentinel picked at spawn time. Read from
   *  `Conversation.resolvedProfile`. `undefined` means default profile. */
  resolvedProfile?: string
  /** Sentinel alias the conversation runs on. Used to look up the profile's
   *  display metadata (color, label) from the live sentinel report. */
  hostSentinelAlias?: string
  /** The user's original intent -- `{ kind: 'profile' | 'pool' }`.
   *  Surfaced as the shuffle icon for `pool`. */
  launchConfig?: LaunchConfig
}

type SentinelProfileIntent = LaunchConfig['sentinelProfile']

function intentLabelFor(intent: SentinelProfileIntent): string | null {
  if (!intent) return null
  if (intent.kind === 'pool') return `Picked from pool "${intent.name}"`
  return null
}

function buildBadgeTitle(resolvedProfile: string, metaLabel: string | undefined, intentLabel: string | null): string {
  const parts = [`Profile: ${resolvedProfile}`]
  if (metaLabel) parts.push(metaLabel)
  if (intentLabel) parts.push(intentLabel)
  return parts.join(' - ')
}

// fallow-ignore-next-line complexity
export function SentinelProfileBadge({ resolvedProfile, hostSentinelAlias, launchConfig }: SentinelProfileBadgeProps) {
  const sentinels = useConversationsStore(s => s.sentinels)
  // Implicit default profile (resolvedProfile = undefined) is rendered as
  // `default` so the badge is visibly distinct from "unknown profile".
  const profileName = resolvedProfile ?? 'default'

  const intent = launchConfig?.sentinelProfile
  const isShuffleIntent = intent?.kind === 'pool'
  const profileMeta = findProfileMeta(sentinels, hostSentinelAlias, profileName)
  // showLabel === false: explicit opt-out from the sentinel config. Skip the
  // badge entirely so the "ambient" profile (typically `default`) doesn't
  // clutter every conversation row. A pool intent still earns a shuffle hint --
  // the user chose a non-fixed selection so the visual signal is meaningful
  // even when the resolved profile is hidden.
  if (profileMeta?.showLabel === false && !isShuffleIntent) return null

  const colorStyle = profileMeta?.color ? { color: profileMeta.color, borderColor: profileMeta.color } : undefined
  const title = buildBadgeTitle(profileName, profileMeta?.label, intentLabelFor(intent))

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[8px] rounded border border-primary/20 bg-muted text-muted-foreground font-medium"
      style={colorStyle}
      title={title}
    >
      {isShuffleIntent && <Shuffle className="w-2.5 h-2.5" />}
      {profileMeta?.showLabel === false ? null : profileDisplayName(profileMeta, profileName)}
    </span>
  )
}

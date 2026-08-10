/**
 * The profiles a conversation's HOST sentinel offers, plus their live usage.
 *
 * Profile-Env Boundary: NAMES + display + usage snapshots only, never configDir
 * or env -- those stay sentinel-local.
 */

import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { buildProfileUsageMap } from '../spawn-dialog/profile-usage'
import { hostSentinelOf } from './revive-defaults'

export function useHostProfiles(conversation: Conversation | undefined) {
  const sentinels = useConversationsStore(s => s.sentinels)
  const profileUsage = useConversationsStore(s => s.profileUsage)

  const sentinel = useMemo(() => hostSentinelOf(conversation, sentinels), [conversation, sentinels])
  const usage = useMemo(() => buildProfileUsageMap(sentinel?.sentinelId, profileUsage), [sentinel, profileUsage])
  const profiles = useMemo(() => sentinel?.profiles ?? [], [sentinel])

  return { profiles, usage }
}

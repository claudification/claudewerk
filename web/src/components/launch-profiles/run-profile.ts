/**
 * Launch a profile.
 *
 * Decision tree:
 *   1. Pin check (sentinel reachable, project URI parseable)
 *      -> on failure: emit a "launch blocked" toast and STOP (D3)
 *   2. Resolve cwd: the profile's pinned project wins; override.cwd is
 *      only a fallback for an unpinned profile.
 *      -> on empty cwd: emit a "launch blocked" toast and STOP.
 *         A chord/palette launch is supposed to inherit cwd from the
 *         currently-selected conversation when no pin is set -- if we
 *         got here with an empty cwd, the caller failed to provide one
 *         and the user should report it.
 *   3. Immediate (default true, D2):
 *      -> sendSpawnRequest with the profile's spawn fields
 *      -> on success: showLaunchToast(conversationId)
 *      -> on failure: emit a launch-failed toast
 *   4. Otherwise:
 *      -> openSpawnDialog pre-filled
 */

import type { LaunchProfile } from '@shared/launch-profile'
import type { SpawnRequest } from '@shared/spawn-schema'
import { openSpawnDialog } from '@/components/spawn-dialog-trigger'
import { type SentinelStatusInfo, useConversationsStore } from '@/hooks/use-conversations'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import { putLaunchProfiles } from './api'
import { openLaunchProfileManager } from './manager-state'
import { checkProfilePins } from './pin-reachability'
import { getLaunchProfilesSnapshot, setLaunchProfiles } from './store'

export interface RunProfileOverride {
  cwd?: string
}

export interface RunProfileDeps {
  sentinels: SentinelStatusInfo[]
  onToast?: (toast: LaunchToast) => void
}

export interface LaunchToast {
  variant: 'blocked' | 'failed'
  title: string
  body: string
  profileId?: string
}

export async function runProfile(
  profile: LaunchProfile,
  override: RunProfileOverride,
  deps: RunProfileDeps,
): Promise<void> {
  const pin = checkProfilePins(profile, deps.sentinels)
  if (!pin.ok) {
    emit(deps, {
      variant: 'blocked',
      title: `Launch blocked: ${profile.name}`,
      body: `${pin.reason}. Edit the profile and try again.`,
      profileId: profile.id,
    })
    return
  }

  // Pinned project URI wins. override.cwd (the currently-selected
  // conversation's cwd) is only a fallback for an unpinned profile.
  const cwd = pin.cwd ?? override.cwd
  if (!cwd) {
    emit(deps, {
      variant: 'blocked',
      title: `Launch blocked: ${profile.name}`,
      body: 'No working directory resolved. Pin a project on the profile, or open a conversation first so the launcher can inherit its cwd. (If you triggered this from a chord with a conversation selected, please report a bug.)',
      profileId: profile.id,
    })
    return
  }

  // Daemon launches need per-launch input a profile cannot carry (RESUME a
  // session id to fork from, ATTACH a roster worker), so they open the spawn
  // dialog pre-filled rather than firing straight to the broker -- regardless
  // of the profile's `immediate` flag. Detected via the canonical `transport`.
  const isDaemon = profile.spawn.transport === 'claude-daemon'
  const immediate = (profile.immediate ?? true) && !isDaemon
  if (!immediate) {
    openSpawnDialog({
      path: cwd,
      sentinel: pin.sentinel,
      projectUri: profile.project,
      // Daemon: pre-fill the dialog with this profile's config. Non-daemon
      // non-immediate keeps its historical "open blank dialog" behavior.
      profileId: isDaemon ? profile.id : undefined,
    })
    return
  }

  await spawnImmediate(profile, cwd, pin.sentinel, deps)
}

async function spawnImmediate(
  profile: LaunchProfile,
  cwd: string,
  sentinel: string | undefined,
  deps: RunProfileDeps,
): Promise<void> {
  const req = buildSpawnRequest(profile, cwd, sentinel)
  const result = await sendSpawnRequest(req)
  if (!result.ok) {
    emit(deps, {
      variant: 'failed',
      title: `Launch failed: ${profile.name}`,
      body: result.error,
      profileId: profile.id,
    })
    return
  }
  useConversationsStore.getState().selectConversation(result.conversationId, 'launch-profile-chord')
  void recordProfileUse(profile.id)
}

async function recordProfileUse(profileId: string): Promise<void> {
  const current = getLaunchProfilesSnapshot()
  if (!current) return
  const now = Date.now()
  const next = current.map(p =>
    p.id === profileId ? { ...p, lastUsedAt: now, useCount: (p.useCount ?? 0) + 1, updatedAt: now } : p,
  )
  setLaunchProfiles(next)
  await putLaunchProfiles(next).catch(() => {
    /* silent -- non-critical telemetry */
  })
}

export function buildSpawnRequest(profile: LaunchProfile, cwd: string, sentinel: string | undefined): SpawnRequest {
  return {
    ...profile.spawn,
    cwd,
    sentinel,
  } as SpawnRequest
}

function emit(deps: RunProfileDeps, toast: LaunchToast): void {
  deps.onToast?.(toast)
}

/** Helper for the toast UI "Edit profile" action. */
export function openEditProfile(profileId: string): void {
  openLaunchProfileManager(profileId)
}

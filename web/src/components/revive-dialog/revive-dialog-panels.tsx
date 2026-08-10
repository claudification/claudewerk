/** Which tab body is on screen. Split out so the container stays a wiring
 *  diagram rather than a wall of props. */

import type { ProfileUsageSnapshot, SentinelProfileInfo } from '@shared/protocol'
import type { UseForkAction } from '../fork-dialog/use-fork-action'
import { ForkTab } from './fork-tab'
import { ReviveTab } from './revive-tab'
import type { UseReviveForm } from './use-revive-form'

export function ReviveDialogPanels({
  form,
  fork,
  reviveConfigurable,
  profiles,
  profileUsage,
  originalProfile,
}: {
  form: UseReviveForm
  fork: UseForkAction
  /** False once a revive is in flight -- the steps list takes over the body. */
  reviveConfigurable: boolean
  profiles: SentinelProfileInfo[]
  profileUsage: Map<string, ProfileUsageSnapshot>
  originalProfile: string
}) {
  if (form.tab === 'fork') {
    return (
      <ForkTab
        fork={fork}
        value={form.forkValue}
        onChange={form.patchFork}
        headless={form.headless}
        onHeadlessChange={form.setHeadless}
        fields={form.fields}
        onFieldsChange={form.applyFields}
        originalProfile={originalProfile}
        profilesCount={profiles.length}
      />
    )
  }

  if (!reviveConfigurable) return null

  return (
    <ReviveTab
      headless={form.headless}
      onHeadlessChange={form.setHeadless}
      fields={form.fields}
      onFieldsChange={form.applyFields}
      profiles={profiles}
      profile={form.profile}
      onProfileChange={form.setProfile}
      profileUsage={profileUsage}
      originalProfile={originalProfile}
    />
  )
}

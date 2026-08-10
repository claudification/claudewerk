/**
 * The REVIVE tab body: the minimal overrides a revive exposes.
 *
 * Everything else (permissionMode, bare, repl, worktree, env, autocompact,
 * budget) is inherited from the conversation's stored launch config and the
 * project/global defaults -- see `reviveConversation` in
 * `src/broker/handlers/control-panel-actions.ts` for the resolution chain.
 */

import type { ProfileUsageSnapshot, SentinelProfileInfo } from '@shared/protocol'
import { haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from '../launch-config-fields'
import { SentinelProfileRadio } from '../spawn-dialog/sentinel-profile-radio'
import { ModeToggle } from './mode-toggle'

export function ReviveTab({
  headless,
  onHeadlessChange,
  fields,
  onFieldsChange,
  profiles,
  profile,
  onProfileChange,
  profileUsage,
  originalProfile,
}: {
  headless: boolean
  onHeadlessChange: (v: boolean) => void
  fields: LaunchFieldsValue
  onFieldsChange: (patch: Partial<LaunchFieldsValue>) => void
  profiles: SentinelProfileInfo[]
  profile: string
  onProfileChange: (v: string) => void
  profileUsage: Map<string, ProfileUsageSnapshot>
  originalProfile: string
}) {
  // Mismatch = reviving onto a DIFFERENT profile than the original. CC's
  // --resume reads the transcript from the original profile's config dir, so a
  // mismatch means CC starts fresh -- warn rather than block.
  const mismatch = !!profile && profile !== originalProfile

  return (
    <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
      <ModeToggle headless={headless} onChange={onHeadlessChange} />

      <LaunchConfigFields value={fields} onChange={onFieldsChange} show={{ model: true, effort: true }} />

      {/* Renders only when the host sentinel reports >1 profile. Default pins to
          the conversation's original profile; the 85% auto-unpin may pre-select
          a fresher one. The Default ("sentinel picks") + pool pills are hidden:
          revive pins to a concrete literal profile and never re-rolls (the
          transcript lives under the resolved configDir). */}
      {profiles.length > 1 && (
        <div className="space-y-2">
          <SentinelProfileRadio
            profiles={profiles}
            pools={[]}
            value={profile}
            onChange={v => {
              onProfileChange(v)
              haptic('tick')
            }}
            poolValue=""
            onPoolChange={() => {}}
            profileUsage={profileUsage}
            hideDefault
          />
          {mismatch && (
            <div className="text-[9px] text-amber-400/90 leading-snug border border-amber-400/30 bg-amber-400/5 rounded px-2 py-1.5">
              Reviving on <span className="font-bold">{profile}</span> instead of the original{' '}
              <span className="font-bold">{originalProfile}</span>. Claude Code resumes its transcript from the original
              profile's config dir -- on a different profile it starts fresh (no in-model context). The panel transcript
              here is unaffected.
            </div>
          )}
        </div>
      )}

      <div className="text-[9px] text-comment leading-snug">
        Other settings (permission mode, env, budget, worktree, etc.) are restored from the original launch config.
        Spawn a new conversation to change them.
      </div>
    </div>
  )
}

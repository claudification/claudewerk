/**
 * Sentinel-profile picker for the spawn dialog.
 *
 * Two mutually-exclusive launch hints:
 *   - Profile pill:  pin to a specific named profile (one pill per reported profile)
 *   - Pool pill:     pick from a named pool -- sentinel resolves least-loaded at spawn
 *   - Default pill:  no hint -- sentinel picks across all profiles
 *
 * Rendered only when the target sentinel reports >1 profile -- single-profile
 * (or unknown) sentinels have nothing to choose between, so the field hides
 * entirely. The user's choice is the launch INTENT; the sentinel resolves it
 * at spawn time and the resolved NAME lands on `Conversation.resolvedProfile`
 * (NOT in the URI).
 *
 * PROFILE-ENV BOUNDARY: this component renders NAME + label + color + pool +
 * authed only. configDir / env are sentinel-local and never reach the UI.
 */

import type { ProfileUsageSnapshot, SentinelProfileInfo } from '@shared/protocol'
import { Check, Hash, User } from 'lucide-react'
import { usageTextColor } from '@/components/usage/usage-colors'
import { cn, formatAge } from '@/lib/utils'

interface SentinelProfileRadioProps {
  /** Profiles reported by the target sentinel (NAMES + display only). */
  profiles: SentinelProfileInfo[]
  /** Pools reported by the target sentinel (distinct, sorted). When length
   *  > 0 and `pool` mode makes sense, pool pills are rendered. */
  pools: string[]
  /** Sentinel's `defaultPool` -- shown as the suggested pool when no pool
   *  has been picked. Defaults to `"default"`. */
  defaultPool?: string
  /** Current profile selection. `''` = no profile pinned. */
  value: string
  onChange: (next: string) => void
  /** Current pool selection. `''` = no pool selected. Mutually exclusive with
   *  `value` -- setting one clears the other in the parent. */
  poolValue: string
  onPoolChange: (next: string) => void
  disabled?: boolean
  /** Per-profile usage snapshots (NAME-keyed). When present, each profile
   *  pill renders inline `5h X% / 7d Y%` so the user can pick by current
   *  headroom. Errored / unauthed / missing entries render "no data". */
  profileUsage?: Map<string, ProfileUsageSnapshot>
  /** Hide the "Default" (no-hint / sentinel-picks) pill. Used by the revive
   *  dialog: revive pins to a concrete literal profile -- the sentinel never
   *  re-rolls on revive (its transcript lives under the resolved profile's
   *  $CLAUDE_CONFIG_DIR), so a "sentinel picks" option is meaningless there.
   *  Defaults to `false` (launch keeps the Default pill). */
  hideDefault?: boolean
}

export function SentinelProfileRadio({
  profiles,
  pools,
  defaultPool,
  value,
  onChange,
  poolValue,
  onPoolChange,
  disabled,
  profileUsage,
  hideDefault,
}: SentinelProfileRadioProps) {
  if (profiles.length < 2) return null

  const noHint = !value && !poolValue
  const onPickDefault = () => {
    onChange('')
    onPoolChange('')
  }
  const onPickProfile = (name: string) => {
    onChange(name)
    onPoolChange('')
  }
  const onPickPool = (name: string) => {
    onChange('')
    onPoolChange(name)
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-mono text-muted-foreground">
        Sentinel profile
        {noHint && !hideDefault && <span className="ml-1.5 text-[9px] text-comment">(no hint - sentinel picks)</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {!hideDefault && <DefaultPill active={noHint} disabled={disabled} onClick={onPickDefault} />}
        {profiles.map(p => (
          <ProfilePill
            key={p.name}
            profile={p}
            active={value === p.name}
            disabled={disabled}
            onClick={() => onPickProfile(p.name)}
            usage={profileUsage?.get(p.name)}
          />
        ))}
      </div>
      {pools.length > 0 && (
        <div className="pt-0.5">
          <div className="text-[10px] font-mono text-muted-foreground mb-1">
            Pool
            {defaultPool && !poolValue && (
              <span className="ml-1.5 text-[9px] text-comment">(default: {defaultPool})</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pools.map(name => (
              <PoolPill
                key={name}
                name={name}
                active={poolValue === name}
                disabled={disabled}
                onClick={() => onPickPool(name)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface ProfilePillProps {
  profile: SentinelProfileInfo
  active: boolean
  disabled?: boolean
  onClick: () => void
  usage?: ProfileUsageSnapshot
}

// fallow-ignore-next-line complexity
function buildProfilePillTitle(profile: SentinelProfileInfo, usage?: ProfileUsageSnapshot): string {
  const poolPart = profile.pool === null ? 'pinned (no pool)' : `pool: ${profile.pool}`
  const authPart = profile.authed ? 'authed' : 'auth unknown (run `sentinel profile auth`)'
  let usagePart = ''
  if (usage?.error) usagePart = `usage: ${usage.error.kind}`
  else if (usage?.fiveHour && usage?.sevenDay) {
    const age = usage.stale ? ` (${formatAge(usage.polledAt)}, poll rate-limited)` : ''
    usagePart = `5h ${Math.round(usage.fiveHour.usedPercent)}% / 7d ${Math.round(usage.sevenDay.usedPercent)}%${age}`
  }
  return [profile.label, poolPart, authPart, usagePart].filter(Boolean).join(' - ')
}

// fallow-ignore-next-line complexity
function ProfilePill({ profile, active, disabled, onClick, usage }: ProfilePillProps) {
  const title = buildProfilePillTitle(profile, usage)
  const colorStyle = profile.color ? { borderColor: profile.color } : undefined
  const fgColor = profile.color ? { color: profile.color } : undefined
  const hasUsage = usage && !usage.error && usage.fiveHour && usage.sevenDay
  const worstPct = hasUsage ? Math.max(usage.fiveHour!.usedPercent, usage.sevenDay!.usedPercent) : 0
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'px-2 py-1 text-[10px] font-mono border rounded flex items-center gap-1.5 cursor-pointer transition-colors',
        // Active must DOMINATE: a vivid inactive profile-color border otherwise
        // out-shouts the real selection. Strong fill + bold + ring lifts it
        // above any colored border; the profile-color tint is dropped so the
        // pill reads as "selected" (primary), not merely "colored".
        active
          ? 'border-primary bg-primary/25 text-primary font-bold ring-2 ring-primary/50'
          : 'border-primary/20 bg-surface-inset text-muted-foreground hover:text-foreground hover:bg-primary/5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      style={active ? undefined : colorStyle}
    >
      {active ? (
        <Check className="w-3 h-3 text-primary" />
      ) : (
        <User className={cn('w-3 h-3', profile.authed ? '' : 'text-amber-400/80')} style={fgColor} />
      )}
      <span style={active ? undefined : fgColor}>{profile.label ?? profile.name}</span>
      {hasUsage && (
        <span className={cn('text-[9px] tabular-nums', usageTextColor(worstPct))}>
          {Math.round(worstPct)}%{usage?.stale && <span className="text-amber-400/70">*</span>}
        </span>
      )}
      {!hasUsage && usage?.error && (
        <span className="text-[8px] text-comment italic">
          {usage.error.kind === 'no_token' ? 'no auth' : 'no data'}
        </span>
      )}
      {profile.pool === null && <span className="text-[8px] text-comment uppercase">pinned</span>}
      {!profile.authed && <span className="text-[8px] text-amber-400/80 uppercase">auth ?</span>}
    </button>
  )
}

interface DefaultPillProps {
  active: boolean
  disabled?: boolean
  onClick: () => void
}

function DefaultPill({ active, disabled, onClick }: DefaultPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="No hint -- sentinel picks across all profiles"
      className={cn(
        'px-2 py-1 text-[10px] font-mono border rounded flex items-center gap-1.5 cursor-pointer transition-colors',
        // Mirror ProfilePill's dominant active treatment for consistency.
        active
          ? 'border-primary bg-primary/25 text-primary font-bold ring-2 ring-primary/50'
          : 'border-primary/20 bg-surface-inset text-muted-foreground hover:text-foreground hover:bg-primary/5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {active && <Check className="w-3 h-3 text-primary" />}
      <span>Default</span>
    </button>
  )
}

interface PoolPillProps {
  name: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}

function PoolPill({ name, active, disabled, onClick }: PoolPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2 py-1 text-[10px] font-mono border rounded flex items-center gap-1.5 cursor-pointer transition-colors',
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-primary/20 bg-surface-inset text-muted-foreground hover:text-foreground hover:bg-primary/5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <Hash className="size-3" />
      <span>{name}</span>
    </button>
  )
}

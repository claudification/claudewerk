/**
 * Sentinel-profile picker for the spawn dialog.
 *
 * Three modes (mutually exclusive radio) per the sentinel-profiles plan:
 *
 *   - Fixed N: pick a specific named profile (one option per reported profile)
 *   - Balanced: sentinel picks the least-loaded profile from a pool
 *   - Random:   sentinel picks a uniformly random profile from a pool
 *
 * When the user selects Balanced or Random AND the sentinel reports >1 pool,
 * a Pool dropdown appears. With a single pool the dropdown is hidden (no
 * choice to make) and the sentinel's `defaultPool` is used implicitly.
 *
 * Rendered only when the target sentinel reports >1 profile -- single-profile
 * (or unknown) sentinels have nothing to choose between, so the field hides
 * entirely. The user's choice is the launch INTENT; the sentinel resolves it
 * at spawn time and the resolved name lands in the conversation URI userinfo.
 *
 * PROFILE-ENV BOUNDARY: this component renders NAME + label + color + pool +
 * authed only. configDir / env are sentinel-local and never reach the UI.
 */

import type { ProfileUsageSnapshot, SentinelProfileInfo } from '@shared/protocol'
import { Hash, Shuffle, User } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Pct -> tailwind text color. Mirrors usage-bar.tsx so the launch modal +
 *  top bar speak the same visual language. */
function usageTextColor(pct: number): string {
  if (pct < 50) return 'text-emerald-400'
  if (pct < 75) return 'text-amber-400'
  if (pct < 90) return 'text-orange-400'
  return 'text-red-400'
}

interface SentinelProfileRadioProps {
  /** Profiles reported by the target sentinel (NAMES + display only). */
  profiles: SentinelProfileInfo[]
  /** Pools reported by the target sentinel (distinct, sorted). When length
   *  > 1 and Balanced/Random is selected, a pool picker is rendered. */
  pools: string[]
  /** Sentinel's `defaultSelection` -- used as the default radio when the
   *  user hasn't explicitly chosen. */
  defaultSelection?: 'default' | 'balanced' | 'random'
  /** Sentinel's `defaultPool` -- the pool used when Balanced/Random is
   *  selected without an explicit pool. Defaults to `"default"`. */
  defaultPool?: string
  /** Current profile selection. `''` = follow sentinel default. Otherwise
   *  either a literal profile name (Fixed) or `'balanced'` / `'random'`. */
  value: string
  onChange: (next: string) => void
  /** Current pool selection (only meaningful for Balanced/Random). `''` =
   *  use the sentinel's defaultPool. */
  poolValue: string
  onPoolChange: (next: string) => void
  disabled?: boolean
  /** Per-profile usage snapshots (NAME-keyed). When present, each profile
   *  pill renders inline `5h X% / 7d Y%` so the user can pick by current
   *  headroom. Errored / unauthed / missing entries render "no data". */
  profileUsage?: Map<string, ProfileUsageSnapshot>
}

export function SentinelProfileRadio({
  profiles,
  pools,
  defaultSelection,
  defaultPool,
  value,
  onChange,
  poolValue,
  onPoolChange,
  disabled,
  profileUsage,
}: SentinelProfileRadioProps) {
  if (profiles.length < 2) return null

  const hasAnyPool = profiles.some(p => p.pool !== null)
  const showSelectionModes = hasAnyPool
  const resolvedValue = value || (defaultSelection && defaultSelection !== 'default' ? defaultSelection : '')
  const showPoolPicker = (resolvedValue === 'balanced' || resolvedValue === 'random') && pools.length > 1
  const resolvedPool = poolValue || defaultPool || 'default'

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-mono text-muted-foreground">
        Sentinel profile
        {defaultSelection && defaultSelection !== 'default' && !value && (
          <span className="ml-1.5 text-[9px] text-comment">
            (sentinel default:{' '}
            <span className="text-foreground" style={{ textTransform: 'lowercase' }}>
              {defaultSelection}
            </span>
            )
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {profiles.map(p => (
          <ProfilePill
            key={p.name}
            profile={p}
            active={resolvedValue === p.name}
            disabled={disabled}
            onClick={() => onChange(p.name)}
            usage={profileUsage?.get(p.name)}
          />
        ))}
      </div>
      {showSelectionModes && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <SelectionPill
            label="Balanced"
            title="Sentinel picks the least-loaded profile from the pool"
            active={resolvedValue === 'balanced'}
            disabled={disabled}
            onClick={() => onChange('balanced')}
          />
          <SelectionPill
            label="Random"
            title="Uniformly random profile from the pool each launch"
            active={resolvedValue === 'random'}
            disabled={disabled}
            onClick={() => onChange('random')}
          />
        </div>
      )}
      {showPoolPicker && (
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
                active={resolvedPool === name}
                disabled={disabled}
                onClick={() => onPoolChange(name)}
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
  /** Latest usage snapshot for this profile (when telemetry is available). */
  usage?: ProfileUsageSnapshot
}

// fallow-ignore-next-line complexity
function buildProfilePillTitle(profile: SentinelProfileInfo, usage?: ProfileUsageSnapshot): string {
  const poolPart = profile.pool === null ? 'pinned (no pool)' : `pool: ${profile.pool}`
  // Auth detection is best-effort -- sentinel only looks for credential
  // files at the configDir root. macOS keychain-stored creds yield a
  // false-negative, so surface as "auth unknown" instead of "not authed".
  const authPart = profile.authed ? 'authed' : 'auth unknown (run `sentinel profile auth`)'
  let usagePart = ''
  if (usage?.error) usagePart = `usage: ${usage.error.kind}`
  else if (usage?.fiveHour && usage?.sevenDay) {
    usagePart = `5h ${Math.round(usage.fiveHour.usedPercent)}% / 7d ${Math.round(usage.sevenDay.usedPercent)}%`
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
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-primary/20 bg-surface-inset text-muted-foreground hover:text-foreground hover:bg-primary/5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      style={active ? undefined : colorStyle}
    >
      <User className={cn('w-3 h-3', profile.authed ? '' : 'text-amber-400/80')} style={fgColor} />
      <span style={fgColor}>{profile.name}</span>
      {hasUsage && (
        <span className={cn('text-[9px] tabular-nums', usageTextColor(worstPct))}>{Math.round(worstPct)}%</span>
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

interface SelectionPillProps {
  label: string
  title: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}

function SelectionPill({ label, title, active, disabled, onClick }: SelectionPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'px-2 py-1 text-[10px] font-mono border rounded flex items-center gap-1.5 cursor-pointer transition-colors',
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-primary/20 bg-surface-inset text-muted-foreground hover:text-foreground hover:bg-primary/5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <Shuffle className="w-3 h-3" />
      <span>{label}</span>
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
      <Hash className="w-3 h-3" />
      <span>{name}</span>
    </button>
  )
}

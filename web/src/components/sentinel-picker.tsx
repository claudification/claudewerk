/**
 * "Which workstation does this run on?" -- one picker, every surface that asks.
 *
 * Lifted out of `launch-profiles/project-uri-builder.tsx` when the schedule
 * editor needed the same control. A schedule fires unattended, so picking the
 * wrong host is a failure nobody is present to see; both surfaces showing the
 * identical control (same ordering, same connected dot) is the point.
 *
 * The value is an ALIAS, never a sentinelId -- aliases are what the project URI
 * authority carries and what `SpawnRequest.sentinel` is matched against.
 */

import { DEFAULT_SENTINEL_NAME } from '@shared/project-uri'
import { useMemo } from 'react'
import { type SentinelStatusInfo, useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'

export interface SentinelOption {
  alias: string
  connected: boolean
  isDefault: boolean
}

/** Sentinel picker options, default-first. Falls back to a synthetic `default`
 *  entry when no sentinel is connected so the picker is never empty (the user
 *  can still type a path by hand). */
function buildSentinelOptions(sentinels: SentinelStatusInfo[] | undefined): SentinelOption[] {
  if (!sentinels || sentinels.length === 0) {
    return [{ alias: DEFAULT_SENTINEL_NAME, connected: false, isDefault: true }]
  }
  return sentinels
    .map(s => ({ alias: s.alias, connected: s.connected, isDefault: !!s.isDefault }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.alias.localeCompare(b.alias))
}

/** The connected sentinels, shaped for the picker. Memoized so the option array
 *  identity survives unrelated store churn. */
export function useSentinelOptions(): SentinelOption[] {
  const sentinels = useConversationsStore(s => s.sentinels)
  return useMemo(() => buildSentinelOptions(sentinels), [sentinels])
}

export function SentinelPicker({
  options,
  value,
  onChange,
  label = 'Sentinel / workstation',
  hint,
}: {
  options: SentinelOption[]
  /** The selected alias. */
  value: string
  onChange: (alias: string) => void
  label?: string
  /** Optional line under the picker -- e.g. what an unpinned choice means. */
  hint?: string
}) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-comment">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map(o => (
          <button
            key={o.alias}
            type="button"
            onClick={() => onChange(o.alias)}
            title={o.connected ? 'Connected' : 'Offline'}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] border transition-colors',
              o.alias === value
                ? 'border-primary/60 text-primary bg-primary/10'
                : 'border-primary/15 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', o.connected ? 'bg-success' : 'bg-muted-foreground/40')} />
            {o.alias}
          </button>
        ))}
      </div>
      {hint && <div className="text-[10px] font-mono text-comment pl-0.5">{hint}</div>}
    </div>
  )
}

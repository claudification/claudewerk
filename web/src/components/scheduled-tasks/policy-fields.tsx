/**
 * The collapsed POLICY section: run type, overlap, catch-up, and the limits.
 *
 * All four are defaulted so nobody has to open this to create a schedule, but
 * each one is a real decision that bites eventually -- a persistent run that
 * never exits, two runs of the same job racing each other, a stampede after an
 * outage -- so they are visible rather than buried in a config file.
 */

import type { ScheduleSpawn } from '@shared/scheduled-task'
import { cn } from '@/lib/utils'

export interface PolicyValue {
  spawn: ScheduleSpawn
  overlap: 'skip' | 'parallel'
  catchUp: 'skip' | 'once'
  maxRuns?: number
}

function Segmented<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string
  hint: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-comment">{label}</div>
      <div className="flex gap-1.5">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex-1 px-2 py-1 text-[11px] font-mono rounded border transition-colors',
              value === opt.value
                ? 'bg-primary/15 text-primary border-primary/30'
                : 'text-comment border-transparent hover:text-muted-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="text-[9px] text-comment pl-0.5">{hint}</div>
    </div>
  )
}

/** Ad-hoc vs persistent is really one decision over two spawn flags. */
function runTypeOf(spawn: ScheduleSpawn): 'adhoc' | 'persistent' {
  return spawn.adHoc && !spawn.leaveRunning ? 'adhoc' : 'persistent'
}

export function PolicyFields({
  value,
  onChange,
}: {
  value: PolicyValue
  onChange: (patch: Partial<PolicyValue>) => void
}) {
  return (
    <div className="space-y-3">
      <Segmented
        label="Run type"
        hint={
          runTypeOf(value.spawn) === 'adhoc'
            ? 'Ad-hoc: runs the prompt, then exits. The default.'
            : 'Persistent: the conversation stays open after the prompt finishes.'
        }
        value={runTypeOf(value.spawn)}
        options={[
          { value: 'adhoc', label: 'Ad-hoc' },
          { value: 'persistent', label: 'Persistent' },
        ]}
        onChange={v =>
          onChange({
            spawn: { ...value.spawn, adHoc: true, leaveRunning: v === 'persistent' },
          })
        }
      />

      <Segmented
        label="If the previous run is still going"
        hint={
          value.overlap === 'skip'
            ? 'Skip this fire and record why.'
            : 'Launch anyway -- two runs of this schedule can overlap.'
        }
        value={value.overlap}
        options={[
          { value: 'skip', label: 'Skip' },
          { value: 'parallel', label: 'Run anyway' },
        ]}
        onChange={v => onChange({ overlap: v })}
      />

      <Segmented
        label="If a run was missed (broker down, machine asleep)"
        hint={
          value.catchUp === 'skip'
            ? 'Record the gap, run nothing. Waking to a queue is worse than a gap.'
            : 'Run once on recovery, if the miss is less than 6 hours old.'
        }
        value={value.catchUp}
        options={[
          { value: 'skip', label: 'Skip' },
          { value: 'once', label: 'Catch up once' },
        ]}
        onChange={v => onChange({ catchUp: v })}
      />

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-comment">Stop after N runs (optional)</div>
        <input
          aria-label="Maximum runs"
          type="number"
          min={1}
          value={value.maxRuns ?? ''}
          onChange={e => onChange({ maxRuns: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="unlimited"
          className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
    </div>
  )
}

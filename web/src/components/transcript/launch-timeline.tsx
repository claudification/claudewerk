/**
 * LaunchTimeline - renders a CC launch lifecycle (initial spawn or /clear
 * reboot) as a compact transcript card. Each step has a status dot, elapsed
 * time, detail, and an (i) button that opens the full raw payload in the
 * global JsonInspector dialog.
 *
 * One card per launchId. Initial spawn and every /clear reboot get their
 * own card so the user always sees how the CC they're talking to was
 * launched + what changed on each reboot.
 */

import type { AgentHostLaunchStep, TranscriptLaunchEntry } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import { elapsedSince, TimelineStepRow } from './timeline-step-row'

const STEP_LABEL: Record<AgentHostLaunchStep, string> = {
  launch_started: 'launching claude',
  clear_requested: '/clear requested',
  process_killed: 'process killed',
  mcp_reset: 'mcp reset',
  settings_regenerated: 'settings regenerated',
  init_received: 'init received',
  ready: 'ready',
  model_changed: 'model changed',
  permission_mode_changed: 'permission mode changed',
  fast_mode_changed: 'fast mode changed',
  mcp_servers_changed: 'mcp servers changed',
  tools_changed: 'tools changed',
  slash_commands_changed: 'slash commands changed',
  skills_changed: 'skills changed',
  agents_changed: 'agents changed',
  plugins_changed: 'plugins changed',
  conversation_exit: 'conversation exit',
}

const LIVE_STEPS = new Set<AgentHostLaunchStep>([
  'model_changed',
  'permission_mode_changed',
  'fast_mode_changed',
  'mcp_servers_changed',
  'tools_changed',
  'slash_commands_changed',
  'skills_changed',
  'agents_changed',
  'plugins_changed',
])

function stepColor(step: AgentHostLaunchStep): string {
  if (step === 'clear_requested') return 'text-amber-400'
  if (step === 'process_killed' || step === 'conversation_exit') return 'text-red-400'
  if (step === 'init_received' || step === 'ready') return 'text-emerald-400'
  if (LIVE_STEPS.has(step)) return 'text-cyan-400'
  return 'text-sky-400'
}

function LaunchLine({ entry, startTs }: { entry: TranscriptLaunchEntry; startTs: number }) {
  const step = entry.step
  const hasRaw = entry.raw !== undefined && entry.raw !== null && Object.keys(entry.raw).length > 0
  const elapsedSec = elapsedSince(entry.timestamp, startTs)

  return (
    <TimelineStepRow
      color={stepColor(step)}
      label={STEP_LABEL[step]}
      elapsedSec={elapsedSec}
      detail={entry.detail ? <span className="text-foreground/70 truncate">{entry.detail}</span> : undefined}
      trailing={
        hasRaw ? (
          <JsonInspector
            title={`launch: ${STEP_LABEL[step]}`}
            data={entry.raw as Record<string, unknown>}
            raw={entry}
          />
        ) : undefined
      }
    />
  )
}

export function LaunchTimeline({ group }: { group: DisplayGroup }) {
  if (group.type !== 'launch') return null
  const entries = group.entries as TranscriptLaunchEntry[]
  if (entries.length === 0) return null
  const phase = entries[0].phase
  const startTs = entries[0].timestamp ? new Date(entries[0].timestamp).getTime() : 0
  const borderClass =
    phase === 'reboot'
      ? 'border-amber-500/30 bg-amber-950/10'
      : phase === 'live'
        ? 'border-cyan-500/30 bg-cyan-950/10'
        : 'border-sky-500/30 bg-sky-950/10'
  const labelClass =
    phase === 'reboot' ? 'text-amber-400/80' : phase === 'live' ? 'text-cyan-400/80' : 'text-sky-400/70'
  const label = phase === 'reboot' ? 'relaunch (/clear)' : phase === 'live' ? 'conversation changed' : 'launch'

  return (
    <div className={cn('mb-3 border-l-2 pl-3 py-1.5 rounded-r', borderClass)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('text-[9px] uppercase tracking-wider font-bold', labelClass)}>{label}</span>
        <span className="text-[9px] text-muted-foreground/50">
          {entries.length} step{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
          // biome-ignore lint/suspicious/noArrayIndexKey: launch entries are a fixed ordered timeline
          <LaunchLine key={i} entry={entry} startTs={startTs} />
        ))}
      </div>
    </div>
  )
}

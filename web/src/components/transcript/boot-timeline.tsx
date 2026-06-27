/**
 * BootTimeline - renders the pre-conversation boot phase as a compact timeline.
 * Each step has a status dot, timestamp, detail line, and an optional (i)
 * icon when a raw payload is available (click to expand full JSON).
 */

import type { BootStep, TranscriptBootEntry } from '@shared/protocol'
import { Info } from 'lucide-react'
import { useState } from 'react'
import { isShareView } from '@/lib/share-mode'
import { haptic } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import type { DisplayGroup } from './grouping'
import { elapsedSince, TimelineStepRow } from './timeline-step-row'

const STEP_LABEL: Record<BootStep, string> = {
  agent_host_started: 'agent host started',
  settings_merged: 'settings merged',
  mcp_prepared: 'mcp config prepared',
  broker_connected: 'broker connected',
  claude_spawning: 'spawning claude',
  claude_started: 'claude started',
  awaiting_init: 'awaiting init',
  init_received: 'init received',
  conversation_ready: 'conversation ready',
  claude_exited: 'claude exited',
  boot_error: 'boot error',
}

function stepColor(step: BootStep): string {
  if (step === 'boot_error' || step === 'claude_exited') return 'text-red-400'
  if (step === 'conversation_ready' || step === 'init_received') return 'text-emerald-400'
  if (step === 'awaiting_init') return 'text-amber-400'
  return 'text-sky-400'
}

function BootLine({ entry, startTs }: { entry: TranscriptBootEntry; startTs: number }) {
  const [open, setOpen] = useState(false)
  const step = entry.step
  // Boot details + raw payloads carry host disk paths, env, and settings/mcp
  // paths (e.g. "cwd=/Users/.../foo"). Strip them for share-link guests.
  const guest = isShareView()
  const hasRaw = !guest && entry.raw !== undefined && entry.raw !== null
  const elapsedSec = elapsedSince(entry.timestamp, startTs)

  return (
    <>
      <TimelineStepRow
        color={stepColor(step)}
        label={STEP_LABEL[step]}
        elapsedSec={elapsedSec}
        detail={
          entry.detail && !guest ? <span className="text-foreground/70 truncate">{entry.detail}</span> : undefined
        }
        trailing={
          hasRaw ? (
            <button
              type="button"
              className="text-muted-foreground/40 hover:text-accent transition-colors"
              title="Show raw payload"
              onClick={() => {
                haptic('tap')
                setOpen(true)
              }}
            >
              <Info className="size-3" />
            </button>
          ) : undefined
        }
      />
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="font-mono max-w-xl">
            <DialogTitle className="pr-8 pb-2 border-b border-border">
              <div className="flex items-center gap-2 text-[11px]">
                <span className={stepColor(step)}>●</span>
                <span>{STEP_LABEL[step]}</span>
                {elapsedSec && <span className="text-muted-foreground/50">+{elapsedSec}s</span>}
              </div>
            </DialogTitle>
            <pre className="text-[10px] overflow-auto max-h-[60vh] p-3 bg-muted/30 rounded whitespace-pre-wrap break-all">
              {JSON.stringify(entry.raw, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

export function BootTimeline({ group }: { group: DisplayGroup }) {
  if (group.type !== 'boot') return null
  const entries = group.entries as TranscriptBootEntry[]
  const startTs = entries[0]?.timestamp ? new Date(entries[0].timestamp).getTime() : 0

  return (
    // intentional visual treatment for the boot-timeline section card (UI design call)
    // react-doctor-disable-next-line react-doctor/no-side-tab-border
    // intentional visual treatment for the boot-timeline section card (UI design call)
    // react-doctor-disable-next-line react-doctor/no-side-tab-border
    <div className="mb-3 border-l-2 border-sky-500/30 pl-3 py-1.5 bg-sky-950/10 rounded-r">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] uppercase tracking-wider text-sky-400/70 font-bold">boot</span>
        <span className="text-[9px] text-muted-foreground/50">
          {entries.length} step{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
          // biome-ignore lint/suspicious/noArrayIndexKey: boot entries are a fixed timeline, no stable IDs
          <BootLine key={i} entry={entry} startTs={startTs} />
        ))}
      </div>
    </div>
  )
}

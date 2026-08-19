/**
 * THE CONTROL BAR -- the whole point of the window.
 *
 * Every verb here already existed on the broker and had no UI: pause and abort
 * were a click and a SHIFT-click on one 10px button, beat and break_lease had no
 * caller at all outside the MCP tool.
 *
 * PAUSE and ABORT are separate BUTTONS now, not two gestures on one control. A
 * modifier key as the only thing between "resume later with the baton intact"
 * and "terminal, no resume" is a UI daring you to make a mistake you cannot
 * undo. ABORT additionally confirms, because it is the one action here that
 * cannot be walked back.
 */

import type { EpicRunSnapshot } from '@shared/protocol'
import { Gauge, Pause, Play, Square, Unlock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { VERBS, type Verb } from './overseer-verbs'

interface Action {
  verb: Verb
  label: string
  icon: ReactNode
  title: string
  danger?: boolean
  /** Guard shown as a disabled button, so the verb is DISCOVERABLE even when it
   *  is not available -- hiding it would teach nobody that it exists. */
  enabled: (run: EpicRunSnapshot | null, leaseHeld: boolean) => boolean
  confirm?: (epicId: string) => string
}

const LIVE = (run: EpicRunSnapshot | null) => run?.status === 'armed' || run?.status === 'running'

const ACTIONS: Action[] = [
  {
    verb: 'pause',
    label: 'PAUSE',
    icon: <Pause className="size-2.5" />,
    title: 'Stop beating. The baton is kept and a later RESUME picks up at this generation.',
    enabled: LIVE,
  },
  {
    verb: 'resume',
    label: 'RESUME',
    icon: <Play className="size-2.5" />,
    title: 'Carry on from the pause. Never re-plans and never restarts the generation count.',
    enabled: run => run?.status === 'paused',
  },
  {
    verb: 'beat',
    label: 'BEAT NOW',
    icon: <Gauge className="size-2.5" />,
    title: 'Run one beat immediately instead of waiting up to 45s. A refusal means the sweep is mid-tick.',
    enabled: LIVE,
  },
  {
    verb: 'break',
    label: 'BREAK LEASE',
    icon: <Unlock className="size-2.5" />,
    title: 'Release a stuck overseer lease so the next beat wakes a fresh one. Refuses a holder still alive.',
    enabled: (_run, leaseHeld) => leaseHeld,
  },
  {
    verb: 'abort',
    label: 'ABORT',
    icon: <Square className="size-2.5" />,
    title: 'TERMINAL. The run stops for good and no RESUME brings it back.',
    danger: true,
    enabled: LIVE,
    confirm: epicId => `Abort the ${epicId} run for good? A pause is resumable; this is not.`,
  },
]

function buttonClass(disabled: boolean, danger?: boolean): string {
  if (disabled) return 'border-border-subtle text-fg-faint cursor-not-allowed'
  return danger
    ? 'border-border text-foreground hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive'
    : 'border-border text-foreground hover:border-[color:var(--epic-badge-edge)] hover:bg-[color:var(--epic-badge-tint)]'
}

export function OverseerControls({
  project,
  epicId,
  run,
  leaseHeld,
  onDone,
}: {
  project: string
  epicId: string
  run: EpicRunSnapshot | null
  leaseHeld: boolean
  onDone: () => void
}) {
  const [busy, setBusy] = useState<Verb | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function run_(action: Action) {
    if (action.confirm && !confirm(action.confirm(epicId))) return
    haptic('tap')
    setBusy(action.verb)
    setNote(null)
    setNote(await VERBS[action.verb]({ project, epicId, run }))
    setBusy(null)
    onDone()
  }

  return (
    <div className="px-3 py-2 border-b border-border shrink-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        {ACTIONS.map(action => {
          const disabled = busy !== null || !action.enabled(run, leaseHeld)
          return (
            <button
              key={action.verb}
              type="button"
              title={action.title}
              disabled={disabled}
              onClick={() => void run_(action)}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono border transition-colors',
                // ABORT is pushed right, away from the thumb's resting place.
                action.danger && 'ml-auto',
                buttonClass(disabled, action.danger),
              )}
            >
              {action.icon}
              {busy === action.verb ? '...' : action.label}
            </button>
          )
        })}
      </div>
      {note && <div className="text-meta text-fg-muted mt-1.5">{note}</div>}
    </div>
  )
}

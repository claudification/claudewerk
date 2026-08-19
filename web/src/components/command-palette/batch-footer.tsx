/**
 * Batch mode's action bar: pick the verb, fill in its form, run it.
 *
 * The old footer restated the selection count a third time ("N of M visible
 * selected") right next to a button already reading "Run on N selected". It
 * says the one thing neither of those can now: how many of your picks the
 * current filter is HIDING -- the only way to run something on a conversation
 * you cannot see.
 */

import { ChevronDown } from 'lucide-react'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import { Kbd } from '../ui/kbd'
import { BatchBroadcastInput, BatchReassignInputs } from './batch-action-inputs'
import { ALL_BATCH_ACTIONS, type BatchAction } from './batch-actions'
import type { ReassignFields } from './batch-run-input'

const HINTS: { keys: string; what: string }[] = [
  { keys: '↑↓', what: 'move' },
  { keys: 'space', what: 'toggle' },
  { keys: 'a', what: 'visible' },
  { keys: 'i', what: 'invert' },
]

export function BatchFooter({
  action,
  onActionChange,
  selectedCount,
  hiddenSelected,
  canRun,
  broadcast,
  onBroadcastChange,
  reassign,
  onReassignChange,
  sentinels,
  onCancel,
  onRun,
}: {
  action: BatchAction
  onActionChange: (id: string) => void
  selectedCount: number
  hiddenSelected: number
  canRun: boolean
  broadcast: string
  onBroadcastChange: (v: string) => void
  reassign: ReassignFields
  onReassignChange: (patch: Partial<ReassignFields>) => void
  sentinels: SentinelStatusInfo[]
  onCancel: () => void
  onRun: () => void
}) {
  return (
    <div className="border-t border-border px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">Action:</span>
        <div className="relative shrink-0">
          <select
            aria-label="Batch action"
            value={action.id}
            onChange={e => onActionChange(e.target.value)}
            className="h-7 bg-muted/20 pl-2 pr-6 border border-border-subtle rounded-sm outline-none appearance-none cursor-pointer transition-colors focus:border-accent"
          >
            {ALL_BATCH_ACTIONS.map(a => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-fg-dim" />
        </div>
        <span className="flex-1 min-w-0 truncate text-[10px] text-fg-muted">{action.description}</span>
        <span className="hidden sm:flex items-center gap-2 shrink-0 text-[9px] text-fg-dim">
          {HINTS.map(h => (
            <span key={h.keys} className="flex items-center gap-1">
              <Kbd className="text-[9px]">{h.keys}</Kbd>
              {h.what}
            </span>
          ))}
        </span>
      </div>

      {action.requiresInput === 'broadcast' && <BatchBroadcastInput value={broadcast} onChange={onBroadcastChange} />}
      {action.requiresInput === 'reassign' && (
        <BatchReassignInputs
          project={reassign.project}
          sentinel={reassign.sentinel}
          profile={reassign.profile}
          sentinels={sentinels}
          onProjectChange={v => onReassignChange({ project: v })}
          onSentinelChange={v => onReassignChange({ sentinel: v })}
          onProfileChange={v => onReassignChange({ profile: v })}
        />
      )}

      <div className="flex items-center justify-end gap-2">
        {hiddenSelected > 0 && (
          <span className="text-[10px] text-amber-400/80 mr-auto">
            {hiddenSelected} selected {hiddenSelected === 1 ? 'is' : 'are'} hidden by the current filter
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-3 text-xs rounded-sm bg-muted/20 hover:bg-muted/40 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canRun}
          onClick={onRun}
          className={cn(
            'h-7 px-3 text-xs font-bold rounded-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            // Red only for genuinely irreversible actions; terminate/reassign
            // are reversible so they keep the neutral accent treatment.
            action.destructive
              ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
              : 'bg-accent/20 text-accent hover:bg-accent/30',
          )}
        >
          Run on {selectedCount} selected
        </button>
      </div>
    </div>
  )
}

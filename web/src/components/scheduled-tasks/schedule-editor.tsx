/**
 * The schedule editor shell: three tabs, a validity gate, and a save button.
 *
 * Deliberately NOT a second launch form. The LAUNCH tab is the very same
 * `LaunchConfigFields` the spawn dialog renders, driven by the very same partial
 * spawn shape -- a schedule is a spawn that happens later, so it is configured
 * with the same controls. Only what is genuinely schedule-specific (the prompt,
 * the cron, the run policy) lives in this folder.
 */

import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { LaunchConfigFields } from '../launch-config-fields'
import { ScheduleBasicTab } from './basic-tab'
import { applyFieldsPatch, toFieldsValue } from './fields-bridge'
import { PolicyFields } from './policy-fields'
import { draftProblem, type ScheduleDraft } from './use-schedule-draft'

type Tab = 'basic' | 'launch' | 'policy'
const TABS: Tab[] = ['basic', 'launch', 'policy']

/** Which launch controls a schedule can meaningfully set (no resume, no attach). */
const LAUNCH_FIELDS_SHOWN = {
  model: true,
  effort: true,
  agent: true,
  permissionMode: true,
  autocompactPct: true,
  maxBudgetUsd: true,
  worktree: true,
} as const

export function ScheduleEditor({
  draft,
  patch,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: ScheduleDraft
  patch: (next: Partial<ScheduleDraft>) => void
  onSave: () => void
  onCancel: () => void
  saving?: boolean
  error?: string | null
}) {
  const [tab, setTab] = useState<Tab>('basic')
  const problem = draftProblem(draft)
  const blocked = Boolean(problem) || Boolean(saving)

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <div className="flex gap-1.5 shrink-0">
        {TABS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t)
              haptic('tick')
            }}
            className={cn(
              'px-3 py-1 text-[11px] font-mono rounded transition-colors capitalize',
              tab === t
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'text-comment hover:text-muted-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 px-0.5 py-1">
        {tab === 'basic' && <ScheduleBasicTab draft={draft} patch={patch} />}
        {tab === 'launch' && (
          <LaunchConfigFields
            value={toFieldsValue(draft)}
            onChange={p => patch(applyFieldsPatch(draft, p))}
            show={LAUNCH_FIELDS_SHOWN}
          />
        )}
        {tab === 'policy' && (
          <PolicyFields
            value={{ spawn: draft.spawn, overlap: draft.overlap, catchUp: draft.catchUp, maxRuns: draft.maxRuns }}
            onChange={p => patch(p)}
          />
        )}
      </div>

      {(error || problem) && (
        <div className="shrink-0 text-[10px] font-mono text-red-400 border border-red-500/30 bg-red-950/20 rounded px-2 py-1.5">
          {error ?? problem}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-[11px] font-mono text-comment hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={blocked}
          className={cn(
            'px-3 py-1.5 text-[11px] font-mono rounded transition-colors',
            blocked
              ? 'bg-surface-inset text-comment cursor-not-allowed'
              : 'bg-primary text-background hover:bg-primary/90',
          )}
        >
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
      </div>
    </div>
  )
}

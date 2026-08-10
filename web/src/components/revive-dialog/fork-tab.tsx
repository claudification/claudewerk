/**
 * The FORK tab body: branch the ended conversation instead of reviving it.
 *
 * Reuses the standalone fork dialog's body verbatim -- same strategies, same
 * fold readout, same retarget fields -- and adds the transport toggle the
 * standalone dialog has no room for. Forking needs no live agent host: the
 * sentinel folds the on-disk transcript, so an ended conversation forks exactly
 * like a running one.
 */

import { ForkDialogBody } from '../fork-dialog/fork-dialog-body'
import type { ForkStrategy } from '../fork-dialog/fork-strategy'
import type { UseForkAction } from '../fork-dialog/use-fork-action'
import type { LaunchFieldsValue } from '../launch-config-fields'
import { ModeToggle } from './mode-toggle'

export interface ForkTabValue {
  strategy: ForkStrategy
  name: string
  cwd: string
  worktree: string
}

export function ForkTab({
  fork,
  value,
  onChange,
  headless,
  onHeadlessChange,
  fields,
  onFieldsChange,
  originalProfile,
  profilesCount,
}: {
  fork: UseForkAction
  value: ForkTabValue
  onChange: (patch: Partial<ForkTabValue>) => void
  headless: boolean
  onHeadlessChange: (v: boolean) => void
  fields: LaunchFieldsValue
  onFieldsChange: (patch: Partial<LaunchFieldsValue>) => void
  originalProfile: string
  profilesCount: number
}) {
  return (
    <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
      <ModeToggle headless={headless} onChange={onHeadlessChange} />

      <ForkDialogBody
        phase={fork.phase}
        stats={fork.stats}
        summary={fork.summary}
        strategy={value.strategy}
        onStrategyChange={v => onChange({ strategy: v })}
        name={value.name}
        onNameChange={v => onChange({ name: v })}
        model={fields.model ?? ''}
        effort={fields.effort ?? ''}
        onFieldsChange={onFieldsChange}
        cwd={value.cwd}
        onCwdChange={v => onChange({ cwd: v })}
        worktree={value.worktree}
        onWorktreeChange={v => onChange({ worktree: v })}
      />

      {/* The profile picker is deliberately absent rather than disabled-in-place:
          a fork is written under, and can only resume from, ONE profile's config
          dir. Only say so where a choice visibly exists on the other tab. */}
      {profilesCount > 1 && (
        <div className="text-[9px] text-comment leading-snug">
          The fork stays on profile <span className="font-mono text-muted-foreground">{originalProfile}</span> -- its
          folded transcript is written there, and Claude Code can only resume it from that profile.
        </div>
      )}
    </div>
  )
}

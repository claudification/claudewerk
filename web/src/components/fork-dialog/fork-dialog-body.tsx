import { LaunchConfigFields, type LaunchFieldsValue } from '../launch-config-fields'
import { FoldStatsReadout } from './fold-stats'
import type { FoldStats } from './fork-api'
import type { ForkStrategy } from './fork-strategy'
import { StrategyPicker } from './strategy-picker'
import type { ForkPhase } from './use-fork-action'

const inputClass =
  'w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50'

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">{label}</div>
      <input
        type="text"
        aria-label={label}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={inputClass}
      />
    </div>
  )
}

export function ForkDialogBody({
  phase,
  stats,
  strategy,
  onStrategyChange,
  name,
  onNameChange,
  model,
  effort,
  onFieldsChange,
  cwd,
  onCwdChange,
  worktree,
  onWorktreeChange,
}: {
  phase: ForkPhase
  stats: FoldStats | null
  strategy: ForkStrategy
  onStrategyChange: (v: ForkStrategy) => void
  name: string
  onNameChange: (v: string) => void
  model: string
  effort: string
  onFieldsChange: (patch: Partial<LaunchFieldsValue>) => void
  cwd: string
  onCwdChange: (v: string) => void
  worktree: string
  onWorktreeChange: (v: string) => void
}) {
  const locked = phase === 'forking' || phase === 'launching'

  return (
    <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
      {/* Strategy is locked once folded -- changing it would invalidate the
          fork that was already written. Close and reopen to pick another. */}
      <StrategyPicker value={strategy} onChange={onStrategyChange} disabled={locked || phase === 'ready'} />

      {stats && <FoldStatsReadout stats={stats} />}

      <Field label="Name" value={name} onChange={onNameChange} placeholder="auto" disabled={locked} />

      <LaunchConfigFields value={{ model, effort }} onChange={onFieldsChange} show={{ model: true, effort: true }} />

      <Field
        label="Working directory"
        value={cwd}
        onChange={onCwdChange}
        placeholder="same as source"
        disabled={locked}
      />
      <Field
        label="Worktree"
        value={worktree}
        onChange={onWorktreeChange}
        placeholder="none -- fork in place"
        disabled={locked}
      />
      <div className="text-[9px] text-comment leading-snug">
        Naming a worktree branches the WORK alongside the context: the fork launches in
        <span className="font-mono"> .claude/worktrees/&lt;name&gt;</span>, created if needed.
      </div>
    </div>
  )
}

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
  summary,
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
  summary: string | null
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
  const busy = phase === 'forking' || phase === 'launching'
  // Anything that determines WHERE the fork was written is frozen the moment it
  // exists. Editing the target after folding would launch in a directory the
  // fork is not in, and CC would silently start fresh. Close and reopen to
  // change it. Name / model / effort stay editable -- they cost nothing.
  const targetFrozen = phase !== 'config'

  // No scroll container of its own: the hosting dialog owns scrolling, so this
  // body can sit inside a tab that already scrolls without nesting two.
  return (
    <div className="space-y-4">
      <StrategyPicker value={strategy} onChange={onStrategyChange} disabled={targetFrozen} />

      {stats && <FoldStatsReadout stats={stats} />}

      {/* Mode C is the lossy one, so the summary is shown for review BEFORE it
          becomes the fork's only context. */}
      {summary && (
        <div className="space-y-1">
          <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
            Inherited context
          </div>
          <div className="max-h-48 overflow-y-auto rounded border border-border bg-surface-inset px-2.5 py-2">
            <pre className="text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono">
              {summary}
            </pre>
          </div>
        </div>
      )}

      <Field label="Name" value={name} onChange={onNameChange} placeholder="auto" disabled={busy} />

      <LaunchConfigFields value={{ model, effort }} onChange={onFieldsChange} show={{ model: true, effort: true }} />

      <Field
        label="Working directory"
        value={cwd}
        onChange={onCwdChange}
        placeholder="same as source"
        disabled={targetFrozen}
      />
      <Field
        label="Worktree"
        value={worktree}
        onChange={onWorktreeChange}
        placeholder="none -- fork in place"
        disabled={targetFrozen}
      />
      <div className="text-[9px] text-comment leading-snug">
        Naming a worktree branches the WORK alongside the context: the fork launches in
        <span className="font-mono"> .claude/worktrees/&lt;name&gt;</span>, created if needed.
      </div>
    </div>
  )
}

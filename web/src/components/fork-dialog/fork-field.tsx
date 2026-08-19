/** The labelled text input the fork dialog uses for name / cwd / worktree. */

const inputClass =
  'w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50'

export function Field({
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

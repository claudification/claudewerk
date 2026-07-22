import { Cloud } from 'lucide-react'
import type { ReactNode } from 'react'

// --- Size picker ---

const LABEL_SIZES = [
  { id: 'xs', label: 'XS' },
  { id: 'sm', label: 'S' },
  { id: '', label: 'M' },
  { id: 'lg', label: 'L' },
  { id: 'xl', label: 'XL' },
]

export function SizePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-0.5">
      {LABEL_SIZES.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          className={`px-2 py-0.5 text-[9px] font-mono border transition-colors ${
            value === s.id
              ? 'border-white text-foreground bg-muted'
              : 'border-border/50 text-muted-foreground hover:border-border'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

// --- Checkbox (the one control style for every boolean setting) ---

export function SettingCheckbox({
  ariaLabel,
  checked,
  onChange,
}: {
  ariaLabel: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <input
      aria-label={ariaLabel}
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      className="accent-primary size-4"
    />
  )
}

// --- Cloud icon for server settings ---

function ServerIcon() {
  return (
    <span title="Server setting (shared)">
      <Cloud className="size-3 text-blue-400/70 shrink-0" />
    </span>
  )
}

// --- Setting row ---

export function SettingRow({
  label,
  description,
  server,
  fullWidth,
  children,
}: {
  label: string
  description: string
  server?: boolean
  fullWidth?: boolean
  children: ReactNode
}) {
  if (fullWidth) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-1.5 min-w-0">
          {server && <ServerIcon />}
          <div className="min-w-0">
            <div className="text-sm text-foreground">{label}</div>
            <div className="text-[10px] text-muted-foreground">{description}</div>
          </div>
        </div>
        <div>{children}</div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-start gap-1.5 min-w-0">
        {server && <ServerIcon />}
        <div className="min-w-0">
          <div className="text-sm text-foreground">{label}</div>
          <div className="text-[10px] text-muted-foreground">{description}</div>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

// --- Group header ---

export function GroupHeader({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider pt-3 pb-1 border-t border-border first:border-t-0 first:pt-0">
      {label}
    </div>
  )
}

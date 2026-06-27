/**
 * TileToggleRow - Keyboard-activable row tile wrapping a ToggleSwitch.
 *
 * role=button + tabIndex=0 + Enter/Space onKeyDown makes the whole row a
 * keyboard-navigable target. Pair with the existing base useKeyLayer gate --
 * single-letter shortcuts still skip when text input is focused.
 */

import { ToggleSwitch } from '@/components/ui/toggle-switch'
import { cn, haptic } from '@/lib/utils'

interface TileToggleRowProps {
  title: string
  subtitle?: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  'aria-label'?: string
}

export function TileToggleRow({
  title,
  subtitle,
  checked,
  onToggle,
  disabled,
  'aria-label': ariaLabel,
}: TileToggleRowProps) {
  function handleToggle() {
    if (disabled) return
    onToggle()
    haptic('tap')
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel || title}
      aria-pressed={checked}
      disabled={disabled}
      className={cn(
        'flex items-center justify-between py-1.5 px-1 rounded cursor-pointer select-none w-full appearance-none bg-transparent border-0 text-left text-inherit',
        'focus:outline-none focus:ring-1 focus:ring-primary/50',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      onClick={handleToggle}
    >
      <div>
        <div className="text-sm font-mono">{title}</div>
        {subtitle && <div className="text-[10px] text-comment">{subtitle}</div>}
      </div>
      <ToggleSwitch on={checked} />
    </button>
  )
}

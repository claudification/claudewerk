/**
 * Two-way tab strip for the revive dialog.
 *
 * Deliberately dumb and local: the launch dialogs are blocking surfaces with a
 * fixed pair of modes, so a shared tab abstraction would cost more than it saves.
 */

import { cn } from '@/lib/utils'

export interface DialogTab<T extends string> {
  value: T
  label: string
  /** Colour applied to the active tab's text + underline. */
  activeClass: string
}

export function DialogTabs<T extends string>({
  tabs,
  value,
  onChange,
  disabled,
}: {
  tabs: DialogTab<T>[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="shrink-0 flex gap-1 border-b border-border" role="tablist">
      {tabs.map(tab => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(tab.value)}
            className={cn(
              'px-3 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              active
                ? `${tab.activeClass} border-current`
                : 'text-muted-foreground/60 border-transparent hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

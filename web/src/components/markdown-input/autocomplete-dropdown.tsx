import { cn } from '@/lib/utils'
import type { AutocompleteItem } from './use-autocomplete'

interface AutocompleteDropdownProps {
  items: AutocompleteItem[]
  selectedIndex: number
  trigger: string | null
  onSelect: (item: string) => void
  onHover: (index: number) => void
}

export function AutocompleteDropdown({ items, selectedIndex, trigger, onSelect, onHover }: AutocompleteDropdownProps) {
  if (!items.length) return null

  const triggerChar = trigger || '/'

  return (
    <div
      role="listbox"
      className="absolute bottom-full left-0 right-0 z-30 mb-1 bg-background border border-border rounded shadow-lg max-h-[240px] overflow-y-auto"
    >
      {items.map((entry, i) => (
        <div
          key={`${triggerChar}${entry.item}`}
          role="option"
          aria-selected={i === selectedIndex}
          tabIndex={-1}
          className={cn(
            'px-3 py-1.5 text-xs font-mono cursor-pointer',
            i === selectedIndex
              ? 'bg-accent/20 text-accent'
              : entry.builtin
                ? 'text-amber-400 hover:bg-muted/50'
                : 'text-foreground hover:bg-muted/50',
          )}
          onClick={() => onSelect(entry.item)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') onSelect(entry.item)
          }}
          onMouseEnter={() => onHover(i)}
        >
          {entry.label ? (
            <span className="truncate">{entry.label}</span>
          ) : (
            <>
              <span className={entry.builtin ? 'text-amber-500/60' : 'text-muted-foreground'}>{triggerChar}</span>
              {entry.item}
              {entry.builtin && <span className="text-amber-500/40 ml-2 text-[10px]">built-in</span>}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

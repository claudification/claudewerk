import type { RefObject } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { SortToggle } from './bits'
import type { SortMode, ViewMode } from './types'

interface SearchHeaderProps {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  mode: ViewMode
  focusedTitle: string
  loading: boolean
  total: number
  sort: SortMode
  onQueryChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onDrillOut: () => void
  onSortChange: (s: SortMode) => void
}

export function SearchHeader({
  inputRef,
  query,
  mode,
  focusedTitle,
  loading,
  total,
  sort,
  onQueryChange,
  onKeyDown,
  onDrillOut,
  onSortChange,
}: SearchHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/15">
      <span className="text-primary text-sm shrink-0">/</span>
      {mode === 'snippets' && (
        <button
          type="button"
          onClick={onDrillOut}
          className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono bg-primary/15 text-primary rounded hover:bg-primary/20 transition-colors cursor-pointer"
        >
          {focusedTitle}
          <span className="ml-1 text-comment">&times;</span>
        </button>
      )}
      <input
        ref={inputRef}
        aria-label="Search transcripts"
        type="text"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={mode === 'snippets' ? `search within ${focusedTitle}...` : 'search all conversations...'}
        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-comment outline-none font-mono"
        spellCheck={false}
        autoComplete="off"
      />
      {loading && <span className="text-[10px] text-comment animate-pulse shrink-0">...</span>}
      {!loading && total > 0 && <span className="text-[10px] text-comment font-mono shrink-0">{total} hits</span>}
      <SortToggle sort={sort} onChange={onSortChange} />
    </div>
  )
}

export function ShortcutBar({ mode }: { mode: ViewMode }) {
  const keys: Array<[string, string]> = [
    ['↑↓', 'navigate'],
    ['Tab', 'drill in'],
    ['Enter', mode === 'conversations' ? 'expand' : 'go to'],
    ['Esc', mode === 'snippets' ? 'back' : 'close'],
  ]
  return (
    <div className="px-4 py-2 border-t border-surface-inset bg-background flex items-center gap-3 text-[10px] text-comment">
      {keys.map(([key, label]) => (
        <span key={label} className="flex items-center gap-1">
          <Kbd className="text-[9px] h-4">{key}</Kbd> {label}
        </span>
      ))}
    </div>
  )
}

/**
 * The board header: project name, view tabs, tools, search, filters.
 *
 * Extracted from `project-board.tsx` when that file crossed the split bar.
 * The ordering is deliberate and is the N2 layout: identity and NAVIGATION on
 * the left where the eye starts, tools on the right, and every MODIFIER
 * (grouping, priority, tags, search) below the rule in the filter row.
 */

import { ListChecks, Search, Sliders } from 'lucide-react'
import type { RefObject } from 'react'
import type { BoardView, BoardViewConfig } from '@/hooks/use-board-view-config'
import { useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { BoardFilters, type BoardFiltersProps } from './board-filters'
import { BoardTabs } from './board-tabs'
import { ViewConfigPanel } from './view-config-panel'

/** The board header's project name label, resolved from the conversation. Kept
 *  as its own component so the header gains no hook. */
function BoardHeaderLabel({ conversationId }: { conversationId: string }) {
  const label = useConversationsStore(s => {
    const uri = s.conversationsById[conversationId]?.project
    return (uri && extractProjectLabel(uri)) || 'Board'
  })
  return (
    <span
      className="text-read font-bold text-foreground font-mono truncate px-3 self-center max-w-[12rem]"
      title={label}
    >
      {label}
    </span>
  )
}

function IconToggle({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      className={cn('p-0.5 transition-colors', active ? 'text-accent' : 'text-fg-dim hover:text-foreground')}
      onClick={() => {
        haptic('tap')
        onClick()
      }}
    >
      {children}
    </button>
  )
}

export interface BoardHeaderProps {
  conversationId: string
  view: BoardViewConfig
  update: <K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => void
  reset: () => void
  tabCounts: Record<BoardView, number>
  configOpen: boolean
  onToggleConfig: () => void
  onBatch: () => void
  onRefresh: () => void
  /** The whole filter hook -- the header renders every control it owns. */
  filters: BoardFilterState
}

/** The slice of `useBoardFilters` the chrome needs. */
export interface BoardFilterState extends Pick<BoardFiltersProps, 'tagFreqs' | 'selectedTags' | 'selectedPriority'> {
  active: boolean
  searchOpen: boolean
  toggleSearch: () => void
  searchQuery: string
  setSearchQuery: (v: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  toggleTag: (tag: string) => void
  togglePriority: (p: string) => void
  clear: () => void
}

export function BoardHeader(props: BoardHeaderProps) {
  const { view, update, filters } = props
  return (
    <div className="flex flex-col border-b border-border shrink-0">
      <div className="flex items-stretch h-9">
        <BoardHeaderLabel conversationId={props.conversationId} />
        <span className="w-px bg-border/60 my-1.5" />
        <BoardTabs view={view.view} counts={props.tabCounts} onChange={v => update('view', v)} />
        <div className="flex items-center gap-2 ml-auto px-3">
          <IconToggle title="Batch select tasks" onClick={props.onBatch}>
            <ListChecks className="size-3.5" />
          </IconToggle>
          <IconToggle title="Filter by title" active={filters.searchOpen} onClick={filters.toggleSearch}>
            <Search className="size-3.5" />
          </IconToggle>
          <IconToggle title="View settings" active={props.configOpen} onClick={props.onToggleConfig}>
            <Sliders className="size-3.5" />
          </IconToggle>
          <button
            type="button"
            className="text-meta text-muted-foreground hover:text-foreground font-mono"
            onClick={props.onRefresh}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        {filters.searchOpen && (
          <div className="flex items-center gap-2">
            <input
              ref={filters.searchRef}
              aria-label="Filter tasks by title"
              type="text"
              value={filters.searchQuery}
              onChange={e => filters.setSearchQuery(e.target.value)}
              onFocus={() => haptic('tap')}
              placeholder="Filter by title..."
              className="flex-1 bg-surface-inset border border-border px-2 py-1 text-read font-mono text-foreground outline-none placeholder:text-fg-dim focus:border-accent/50"
            />
            {filters.active && (
              <button
                type="button"
                className="text-chrome text-fg-dim hover:text-foreground font-mono shrink-0"
                onClick={filters.clear}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {props.configOpen && <ViewConfigPanel view={view} update={update} reset={props.reset} />}

        <BoardFilters
          tagFreqs={filters.tagFreqs}
          selectedTags={filters.selectedTags}
          onToggleTag={filters.toggleTag}
          selectedPriority={filters.selectedPriority}
          onTogglePriority={filters.togglePriority}
          groupBy={view.groupBy}
          onGroupBy={g => update('groupBy', g)}
          showGrouping={view.view === 'board'}
        />
      </div>
    </div>
  )
}

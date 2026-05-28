/**
 * Sheaf header controls: project filter, sort select, status-filter chips,
 * the "X of Y projects" count, and the collapse-all/expand-all toggle.
 */

import type { SheafStatus } from '@shared/sheaf-types'
import { ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { SORT_OPTIONS, type SortKey } from './sheaf-derive'
import { STATUS_COLOR, STATUS_GLYPH, STATUS_ORDER } from './sheaf-status'
import type { SheafFilters } from './use-sheaf-filters'

function FilterBox({
  filter,
  setFilter,
  filterRef,
}: {
  filter: string
  setFilter: (s: string) => void
  filterRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="relative flex items-center">
      <Search className="absolute left-2 size-3.5 text-muted-foreground/60 pointer-events-none" />
      <input
        ref={filterRef}
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="filter projects…  ( / )"
        className="w-52 pl-7 pr-7 py-1 text-xs rounded border border-border bg-background/60 focus:bg-background focus:border-foreground/30 outline-none transition-colors"
      />
      {filter.length > 0 && (
        <button
          type="button"
          onClick={() => setFilter('')}
          className="absolute right-1.5 text-muted-foreground/60 hover:text-foreground"
          aria-label="Clear filter"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function SortSelect({ sort, setSort }: { sort: SortKey; setSort: (s: SortKey) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
      sort
      <select
        value={sort}
        onChange={e => setSort(e.target.value as SortKey)}
        className="text-xs font-mono rounded border border-border bg-background/60 px-1.5 py-1 outline-none focus:border-foreground/30"
      >
        {SORT_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function StatusChips({
  statusFilter,
  toggleStatus,
}: {
  statusFilter: Set<SheafStatus>
  toggleStatus: (s: SheafStatus) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {STATUS_ORDER.map(s => {
        const active = statusFilter.has(s)
        return (
          <button
            key={s}
            type="button"
            onClick={() => toggleStatus(s)}
            aria-pressed={active}
            title={`${active ? 'hide' : 'show only'} ${s}`}
            className={`flex items-center gap-1 px-1.5 py-1 rounded border text-[10px] uppercase tracking-wide transition-colors ${
              active
                ? 'border-foreground/30 bg-foreground/10 text-foreground'
                : 'border-transparent text-muted-foreground/60 hover:bg-foreground/5'
            }`}
          >
            <span className={STATUS_COLOR[s]}>{STATUS_GLYPH[s]}</span>
            <span className="hidden lg:inline">{s}</span>
          </button>
        )
      })}
    </div>
  )
}

export function SheafControlsRow({
  filters,
  filterRef,
}: {
  filters: SheafFilters
  filterRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="max-w-[1600px] mx-auto px-4 pb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <FilterBox filter={filters.filter} setFilter={filters.setFilter} filterRef={filterRef} />
      <SortSelect sort={filters.sort} setSort={filters.setSort} />
      <StatusChips statusFilter={filters.statusFilter} toggleStatus={filters.toggleStatus} />
      <div className="ml-auto flex items-center gap-3">
        {filters.filtersActive && (
          <span className="text-[10px] text-muted-foreground/70 font-mono">
            {filters.visibleProjects.length} of {filters.totalCount} projects
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={filters.toggleAll} className="gap-1">
          {filters.anyExpanded ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
          <span className="text-xs hidden sm:inline">{filters.anyExpanded ? 'Collapse all' : 'Expand all'}</span>
        </Button>
      </div>
    </div>
  )
}

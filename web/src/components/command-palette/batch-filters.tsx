/**
 * The four filter inputs across the top of batch mode.
 *
 * The project box searches the project's DISPLAY LABEL as well as its URI --
 * see batch-filter.ts for why that is the whole point.
 */

import { ChevronDown } from 'lucide-react'
import type { FilterState } from './batch-filter'

const FIELD =
  'h-7 bg-muted/20 px-2 border border-border-subtle outline-none rounded-sm transition-colors focus:border-accent placeholder:text-fg-faint'

const STATUS_OPTIONS: { value: FilterState['status']; label: string }[] = [
  { value: 'any', label: 'any status' },
  { value: 'live', label: 'live' },
  { value: 'idle', label: 'idle' },
]

export function BatchFilters({
  filter,
  onChange,
}: {
  filter: FilterState
  onChange: (patch: Partial<FilterState>) => void
}) {
  return (
    <div className="grid grid-cols-4 gap-2 px-3 py-2 border-b border-border text-xs">
      <input
        aria-label="Filter conversations by project name or path"
        placeholder="project (name or path)"
        value={filter.project}
        onChange={e => onChange({ project: e.target.value })}
        className={FIELD}
      />
      <div className="relative">
        <select
          aria-label="Filter conversations by status"
          value={filter.status}
          onChange={e => onChange({ status: e.target.value as FilterState['status'] })}
          className={`${FIELD} w-full appearance-none pr-6 cursor-pointer`}
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-fg-dim" />
      </div>
      <input
        aria-label="Filter conversations by sentinel"
        placeholder="sentinel"
        value={filter.sentinel}
        onChange={e => onChange({ sentinel: e.target.value })}
        className={FIELD}
      />
      <input
        aria-label="Filter conversations by text search"
        placeholder="search title"
        value={filter.text}
        onChange={e => onChange({ text: e.target.value })}
        className={FIELD}
      />
    </div>
  )
}

/**
 * The batch conversation table.
 *
 * FIXED LAYOUT ON PURPOSE: a `table-auto` here let the `last` column wrap
 * ("27h 2m" / "ago"), which doubled random row heights and made the whole list
 * look ragged. Every column now has a declared width, the narrow ones never
 * wrap, and the wide ones truncate with a `title` tooltip.
 */

import type { ProjectSettings } from '@/lib/types'
import { type ColumnSpec, columnCount } from './batch-cells'
import type { FlatRow } from './batch-grouping'
import { BatchGroupHeader, BatchRow } from './batch-row'

/** Declared width per column, in table order. Fixed px for the narrow ones,
 *  percentages for the text ones; `recap` takes whatever is left over. */
const WIDTH: Record<string, string | undefined> = {
  select: '34px',
  title: '32%',
  project: '15%',
  host: '14%',
  recap: undefined,
  status: '92px',
  last: '58px',
}

function columnKeys(cols: ColumnSpec): string[] {
  return [
    'select',
    'title',
    ...(cols.project ? ['project'] : []),
    ...(cols.host ? ['host'] : []),
    ...(cols.recap ? ['recap'] : []),
    'status',
    'last',
  ]
}

export function BatchTable({
  rows,
  cols,
  projectSettings,
  focusedIndex,
  isSelected,
  groupState,
  onToggleGroup,
  onActivate,
  onFocusRow,
}: {
  rows: FlatRow[]
  cols: ColumnSpec
  projectSettings: Record<string, ProjectSettings>
  focusedIndex: number
  isSelected: (id: string) => boolean
  groupState: (project: string) => { checked: boolean; indeterminate: boolean }
  onToggleGroup: (project: string) => void
  onActivate: (idx: number, shift: boolean) => void
  onFocusRow: (idx: number) => void
}) {
  const keys = columnKeys(cols)
  const empty = !rows.some(r => r.kind === 'conv')

  return (
    <table className="w-full table-fixed text-[11px] font-mono">
      <colgroup>
        {keys.map(k => (
          <col key={k} style={WIDTH[k] ? { width: WIDTH[k] } : undefined} />
        ))}
      </colgroup>
      <thead className="sticky top-0 bg-surface-inset border-b border-border/40 text-[10px] text-muted-foreground uppercase tracking-wider z-10">
        <tr>
          <th className="px-2 py-1.5">
            <span className="sr-only">Selection</span>
          </th>
          <th className="text-left px-2 py-1.5 font-normal">title</th>
          {cols.project && <th className="text-left px-2 py-1.5 font-normal">project</th>}
          {cols.host && <th className="text-left px-2 py-1.5 font-normal">host</th>}
          {cols.recap && <th className="text-left px-2 py-1.5 font-normal">recap</th>}
          <th className="text-left px-2 py-1.5 font-normal">status</th>
          <th className="text-right px-2 py-1.5 font-normal">last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) =>
          row.kind === 'group' ? (
            <BatchGroupHeader
              key={`g:${row.project}`}
              row={row}
              cols={cols}
              {...groupState(row.project)}
              onToggle={() => onToggleGroup(row.project)}
            />
          ) : (
            <BatchRow
              key={row.conv.id}
              row={row}
              idx={idx}
              cols={cols}
              checked={isSelected(row.conv.id)}
              focused={idx === focusedIndex}
              projectSettings={projectSettings}
              onActivate={onActivate}
              onFocus={() => onFocusRow(idx)}
            />
          ),
        )}
        {empty && (
          <tr>
            <td colSpan={columnCount(cols)} className="px-3 py-8 text-center text-muted-foreground">
              No conversations match
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

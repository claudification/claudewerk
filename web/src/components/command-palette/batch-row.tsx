/**
 * The two row shapes of the batch table: a project group header and a
 * conversation row. Both are pure -- selection state and the toggle callbacks
 * come in as props so the table stays a dumb renderer.
 */

import { formatAgeShort } from '@/lib/status-style'
import type { ProjectSettings } from '@/lib/types'
import { cn, formatAge } from '@/lib/utils'
import { ProjectIcon } from '../project-icons'
import { StatusIcon } from '../project-list/status-icon'
import { type ColumnSpec, columnCount, hostLabel, MutedDefault, recapSnippet, StatusDot } from './batch-cells'
import { type ConvRow, effectiveProject, type GroupRow, projectLabelFor } from './batch-grouping'

export function BatchGroupHeader({
  row,
  cols,
  checked,
  indeterminate,
  onToggle,
}: {
  row: GroupRow
  cols: ColumnSpec
  checked: boolean
  indeterminate: boolean
  onToggle: () => void
}) {
  return (
    <tr className="bg-muted/25 border-y border-border-subtle">
      <td colSpan={columnCount(cols)} className="px-2 py-1.5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
          <input
            ref={el => {
              if (el) el.indeterminate = indeterminate
            }}
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select all in ${row.label}`}
            className="cursor-pointer accent-accent"
          />
          {row.color && <span className="size-2 rounded-sm shrink-0" style={{ backgroundColor: row.color }} />}
          {row.icon && (
            <span className="shrink-0 text-muted-foreground">
              <ProjectIcon iconId={row.icon} className="size-3" />
            </span>
          )}
          <span className="text-foreground font-bold truncate">{row.label}</span>
          <span className="text-fg-dim shrink-0">({row.count})</span>
        </div>
      </td>
    </tr>
  )
}

export function BatchRow({
  row,
  idx,
  checked,
  focused,
  cols,
  projectSettings,
  onActivate,
  onFocus,
}: {
  row: ConvRow
  idx: number
  checked: boolean
  focused: boolean
  cols: ColumnSpec
  projectSettings: Record<string, ProjectSettings>
  onActivate: (idx: number, shift: boolean) => void
  onFocus: () => void
}) {
  const { conv } = row
  const ps = projectSettings[effectiveProject(conv)]
  const title = conv.title || conv.id.slice(0, 8)
  const host = hostLabel(conv)
  const recap = recapSnippet(conv)

  return (
    <tr
      className={cn(
        'border-b border-border-subtle cursor-pointer transition-colors align-middle',
        checked ? 'bg-accent/10 hover:bg-accent/15' : 'hover:bg-muted/10',
        focused && 'ring-1 ring-accent/40 ring-inset',
      )}
      style={ps?.color ? { boxShadow: `inset 3px 0 0 ${ps.color}` } : undefined}
      onClick={e => onActivate(idx, e.shiftKey)}
      onMouseEnter={onFocus}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only stops the row's click from double-toggling the checkbox; keyboard selection is the modal's `space` key layer */}
      <td className="px-2 py-1" onClick={e => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onActivate(idx, (e.nativeEvent as MouseEvent).shiftKey)}
          aria-label={`Select ${title}`}
          className="cursor-pointer accent-accent align-middle"
        />
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={conv.status} />
          <span className="truncate" title={title}>
            {title}
          </span>
        </div>
      </td>
      {cols.project && (
        <td className="px-2 py-1">
          <span className="flex items-center gap-1.5 min-w-0" title={conv.project}>
            {ps?.icon && (
              <span className="text-fg-muted shrink-0">
                <ProjectIcon iconId={ps.icon} className="size-3" />
              </span>
            )}
            <span className="truncate">{projectLabelFor(conv, projectSettings)}</span>
          </span>
        </td>
      )}
      {cols.host && (
        <td className="px-2 py-1">
          <div className="truncate" title={host ?? undefined}>
            <MutedDefault value={host} />
          </div>
        </td>
      )}
      {cols.recap && (
        <td className="px-2 py-1 text-fg-muted">
          <div className="truncate" title={recap ?? undefined}>
            <MutedDefault value={recap} />
          </div>
        </td>
      )}
      <td className="px-2 py-1 whitespace-nowrap">
        <StatusIcon status={conv.liveStatus} lastInputAt={conv.lastInputAt} />
      </td>
      <td
        className="px-2 py-1 text-right whitespace-nowrap text-fg-muted tabular-nums"
        title={formatAge(conv.lastActivity)}
      >
        {formatAgeShort(conv.lastActivity)}
      </td>
    </tr>
  )
}

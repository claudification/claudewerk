/**
 * The rows batch mode shows: filter -> scope -> sort -> group, plus which
 * optional columns are worth rendering for the result.
 */

import { useMemo } from 'react'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { type ColumnSpec, hostLabel, recapSnippet } from './batch-cells'
import { type FilterState, filterConversations } from './batch-filter'
import { type ConvRow, defaultSort, type FlatRow, flatten } from './batch-grouping'

export interface BatchRows {
  flatRows: FlatRow[]
  convRows: ConvRow[]
  cols: ColumnSpec
  /** Indices into flatRows that arrow-key focus is allowed to land on. */
  focusableIndices: number[]
}

export function useBatchRows({
  conversations,
  filter,
  projectSettings,
  groupByProject,
  selectedOnly,
  selected,
}: {
  conversations: Conversation[]
  filter: FilterState
  projectSettings: Record<string, ProjectSettings>
  groupByProject: boolean
  selectedOnly: boolean
  selected: Set<string>
}): BatchRows {
  const flatRows = useMemo(() => {
    const base = filterConversations(conversations, filter, projectSettings)
    const scoped = selectedOnly ? base.filter(c => selected.has(c.id)) : base
    return flatten(
      scoped.toSorted((a, b) => defaultSort(a, b, projectSettings)),
      groupByProject,
      projectSettings,
    )
  }, [conversations, filter, selectedOnly, selected, projectSettings, groupByProject])

  const convRows = useMemo(() => flatRows.filter((r): r is ConvRow => r.kind === 'conv'), [flatRows])

  // Hide `host` when every visible conversation runs on the implicit default,
  // and `recap` when no visible row has recap content. Keeps the table honest
  // about how dense it actually is.
  const cols = useMemo<ColumnSpec>(
    () => ({
      project: !groupByProject,
      host: convRows.some(r => hostLabel(r.conv) !== null),
      recap: convRows.some(r => recapSnippet(r.conv) !== null),
    }),
    [convRows, groupByProject],
  )

  const focusableIndices = useMemo(() => flatRows.flatMap((r, i) => (r.kind === 'conv' ? [i] : [])), [flatRows])

  return { flatRows, convRows, cols, focusableIndices }
}

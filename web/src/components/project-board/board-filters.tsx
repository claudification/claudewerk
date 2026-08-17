/**
 * The filter row: what narrows or rearranges what you are already looking at.
 *
 * `group by` lives HERE, not in the title bar, and looks like a labelled select
 * rather than like the view tabs. Navigation and modifiers sharing one visual
 * treatment is what made the old header unreadable: you could not tell which
 * control changed where you were and which changed what you saw.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, haptic } from '@/lib/utils'
import { CHIP_IDLE, PRIORITY_COLORS, tagColor } from './board-constants'
import { GROUP_BY_OPTIONS, type GroupBy } from './board-grouping'

const GROUP_LABEL: Record<GroupBy, string> = {
  none: 'nothing',
  epic: 'epic',
  tag: 'tag',
  priority: 'priority',
}

export interface BoardFiltersProps {
  groupBy: GroupBy
  onGroupBy: (value: GroupBy) => void
  /** Grouping is a BOARD concern; the epics view hides the control entirely. */
  showGrouping: boolean
  tagFreqs: Array<{ tag: string; count: number }>
  selectedTags: Set<string>
  onToggleTag: (tag: string) => void
  selectedPriority: string | null
  onTogglePriority: (p: string) => void
}

export function BoardFilters(props: BoardFiltersProps) {
  return (
    <div className="flex items-center gap-1.5">
      {props.showGrouping && (
        <>
          <span className="text-chrome font-mono text-muted-foreground/60 shrink-0">GROUP</span>
          <Select value={props.groupBy} onValueChange={v => props.onGroupBy(v as GroupBy)}>
            <SelectTrigger
              size="sm"
              className="h-6 w-auto gap-1.5 px-2 py-0 font-mono text-meta border-border/70 shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUP_BY_OPTIONS.map(g => (
                <SelectItem key={g} value={g} className="font-mono text-meta">
                  {GROUP_LABEL[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="w-px h-3 bg-border/30 mx-0.5 shrink-0" />
        </>
      )}

      {(['high', 'medium', 'low'] as const).map(p => (
        <button
          key={p}
          type="button"
          onClick={() => {
            haptic('tap')
            props.onTogglePriority(p)
          }}
          className={cn(
            'px-1.5 py-0.5 text-chrome font-mono border rounded transition-colors shrink-0',
            props.selectedPriority === p ? PRIORITY_COLORS[p] : CHIP_IDLE,
          )}
        >
          {p}
        </button>
      ))}

      <span className="w-px h-3 bg-border/30 mx-0.5 shrink-0" />

      <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0 scrollbar-none">
        {props.tagFreqs.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => {
              haptic('tap')
              props.onToggleTag(tag)
            }}
            className={cn(
              'px-1.5 py-0.5 text-chrome font-mono border rounded whitespace-nowrap shrink-0 transition-colors',
              props.selectedTags.has(tag) ? tagColor(tag) : CHIP_IDLE,
            )}
          >
            {tag}
            <span className="ml-0.5 tabular-nums opacity-50">{count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

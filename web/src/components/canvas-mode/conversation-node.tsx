// One conversation on THE CANVAS: status dot, name, model, live counters.
// Click expands it in place into a live mini-transcript card (expanded-card).
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { formatAgo, formatCost, formatTokens } from '@/sheaf/format'
import { type ConversationCardData, STATUS_ACCENT } from './canvas-types'
import { ExpandedCard } from './expanded-card'
import { useCanvasActions } from './use-expanded'

function cardClass(d: ConversationCardData, selected: boolean | undefined): string {
  return cn(
    'w-[252px] rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm transition-colors cursor-pointer',
    'hover:border-foreground/30',
    selected && 'ring-2 ring-ring',
    d.status === 'ended' && 'opacity-55',
    d.attention && 'border-warning',
  )
}

function StatusDot({ d }: { d: ConversationCardData }) {
  const accent = STATUS_ACCENT[d.status] ?? STATUS_ACCENT.idle
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', accent.pulse && 'animate-pulse')}
      style={{ backgroundColor: accent.dot }}
    />
  )
}

function AttentionBadge({ attention }: { attention?: string }) {
  if (!attention) return null
  return (
    <span className="shrink-0 rounded bg-warning/20 px-1 text-[9px] font-semibold uppercase text-warning">
      {attention}
    </span>
  )
}

function statusText(d: ConversationCardData): string {
  if (d.compacting) return 'compacting'
  return (STATUS_ACCENT[d.status] ?? STATUS_ACCENT.idle).label
}

function TitleRow({ d }: { d: ConversationCardData }) {
  return (
    <div className="flex items-center gap-2">
      <StatusDot d={d} />
      <span className="truncate font-mono text-xs font-semibold">{d.label}</span>
      <AttentionBadge attention={d.attention} />
      <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground">{statusText(d)}</span>
    </div>
  )
}

function ModelRow({ d }: { d: ConversationCardData }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
      <span className="truncate">{d.model ? d.model.replace(/^claude-/, '') : '--'}</span>
      {d.childCount > 0 && (
        <span className="shrink-0 rounded border border-border px-1 text-[9px]">{d.childCount} spawned</span>
      )}
    </div>
  )
}

function StatsRow({ d }: { d: ConversationCardData }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
      <span>{formatTokens(d.tokens)} tok</span>
      {typeof d.costUsd === 'number' && <span>{formatCost(d.costUsd, false)}</span>}
      <span className="ml-auto">{formatAgo(d.agoMs)}</span>
    </div>
  )
}

export function ConversationNode({ id, data, selected }: NodeProps) {
  const d = data as ConversationCardData
  const { toggleExpand } = useCanvasActions()
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="!bg-border !border-border" />
      <Handle type="target" position={Position.Left} id="host" className="!bg-border !border-border opacity-40" />
      {d.expanded ? (
        <ExpandedCard id={id} d={d} selected={selected} onCollapse={toggleExpand} />
      ) : (
        <div className={cardClass(d, selected)}>
          <TitleRow d={d} />
          <ModelRow d={d} />
          <StatsRow d={d} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-border !border-border" />
    </div>
  )
}

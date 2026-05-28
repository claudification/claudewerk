/**
 * Sheaf tree + node renderers. Dense, information-rich, status-glyphed.
 */

import type { SheafNode } from '@shared/sheaf-types'
import { useConversationsStore } from '@/hooks/use-conversations'
import { costHeatClass, formatClockTime, formatCost, formatDuration, formatTokens } from './format'
import { STATUS_BG, STATUS_COLOR, STATUS_GLYPH } from './sheaf-status'

interface SheafNodeRowProps {
  node: SheafNode
  depth: number
  now: number
}

function selectConv(id: string) {
  const store = useConversationsStore.getState()
  store.selectConversation(id, 'sheaf')
  // selectConversation routes hash via history.replaceState, which does NOT
  // fire `hashchange`. App's useHash listens to hashchange only, so without
  // this nudge SheafPage stays mounted on top of the dashboard.
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

function SheafNodeRow({ node, depth, now }: SheafNodeRowProps) {
  const glyph = STATUS_GLYPH[node.status]
  const startStr = formatClockTime(node.startedAt)
  const endStr = node.endedAt ? formatClockTime(node.endedAt) : null
  const duration = formatDuration(node.durationMs)
  const showTree = node.treeTotals.convCount > 1
  const totalTokens = node.tokens.input + node.tokens.output + node.tokens.cache

  return (
    <div
      className="group border-l-2 border-transparent hover:border-foreground/30 hover:bg-foreground/[0.03] transition-colors px-2 py-1.5 cursor-pointer"
      style={{ marginLeft: depth * 20 }}
      onClick={() => selectConv(node.id)}
      onKeyDown={e => {
        if (e.key === 'Enter') selectConv(node.id)
      }}
      role="button"
      tabIndex={0}
      title={`${node.id} - click to open conversation`}
    >
      {/* Row 1: glyph + title + status badge */}
      <div className="flex items-baseline gap-2 min-w-0">
        <span className={`${STATUS_COLOR[node.status]} font-bold shrink-0`}>{glyph}</span>
        <span className="font-medium text-foreground truncate">{node.title}</span>
        <span
          className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_BG[node.status]} ${STATUS_COLOR[node.status]}`}
        >
          {node.status}
        </span>
        {node.worktreeName && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 font-mono">
            wt:{node.worktreeName}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60 font-mono">{node.id.slice(0, 10)}</span>
      </div>

      {/* Row 2: metrics grid */}
      <div className="mt-0.5 grid grid-cols-12 gap-x-3 gap-y-0.5 text-xs">
        <div className="col-span-4 text-muted-foreground">
          <span className="font-mono">{startStr}</span>
          {endStr ? (
            <>
              {' → '}
              <span className="font-mono">{endStr}</span>
            </>
          ) : (
            <span className="text-emerald-400/80"> → running</span>
          )}
          <span className="ml-1 opacity-70">({duration})</span>
        </div>
        <div className="col-span-3 text-muted-foreground">
          <span className="font-mono">{formatTokens(totalTokens)}</span>
          <span className="opacity-60 ml-1">
            {formatTokens(node.tokens.input)}/{formatTokens(node.tokens.output)} (+{formatTokens(node.tokens.cache)}c)
          </span>
        </div>
        <div className={`col-span-2 font-mono ${costHeatClass(node.cost.amount)}`}>
          {formatCost(node.cost.amount, node.cost.estimated)}
        </div>
        <div className="col-span-3 text-muted-foreground truncate" title={node.model ?? ''}>
          {node.model ?? '-'}
        </div>
      </div>

      {/* Row 3: outcome line */}
      <div className="mt-0.5 text-xs text-muted-foreground italic truncate" title={node.outcomeLine}>
        ▸ {node.outcomeLine}
      </div>

      {/* Tree-rollup row (only when this node has descendants) */}
      {showTree && (
        <div className="mt-1 ml-4 text-[10px] text-muted-foreground/70 font-mono border-l border-foreground/10 pl-2">
          Σ {node.treeTotals.convCount} convs · {formatDuration(node.treeTotals.durationWallMs)} wall ·{' '}
          {formatTokens(node.treeTotals.tokens.input + node.treeTotals.tokens.output + node.treeTotals.tokens.cache)}{' '}
          tok
          {' · '}
          {formatCost(node.treeTotals.cost.amount, node.treeTotals.cost.estimated)}
        </div>
      )}

      {void now}
    </div>
  )
}

interface SheafTreeProps {
  root: SheafNode
  now: number
}

function visit(node: SheafNode, depth: number, now: number, rows: React.ReactNode[]): void {
  rows.push(<SheafNodeRow key={node.id} node={node} depth={depth} now={now} />)
  for (const child of node.children) visit(child, depth + 1, now, rows)
}

export function SheafTree({ root, now }: SheafTreeProps) {
  const rows: React.ReactNode[] = []
  visit(root, 0, now, rows)
  return <div className="border border-border/50 rounded">{rows}</div>
}

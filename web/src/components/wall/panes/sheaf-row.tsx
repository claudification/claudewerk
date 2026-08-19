/**
 * One project's line in A6: name and cost on top, everything else on the
 * sub-line, exactly as the mockup lays it out.
 *
 * The tree bar is a GLYPH, not a chart -- one tick per spawn tree, capped at
 * fourteen, with the count spelled out beside it so the cap can never read as
 * "that is all of them".
 */

import type { SheafRow } from '@/lib/wall/sheaf-rows'
import { formatTokens } from '@/lib/wall/sheaf-rows'
import { ProjectTag } from '../../project-tag'

const MAX_TICKS = 14

function TreeBar({ trees }: { trees: number }) {
  const ticks = Math.min(trees, MAX_TICKS)
  return (
    <span className="wall-sheaf-treebar" title={`${trees} spawn tree${trees === 1 ? '' : 's'}`}>
      {Array.from({ length: ticks }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional, they carry no identity
        <i key={i} style={{ height: `${4 + ((i * 5) % 8)}px` }} />
      ))}
    </span>
  )
}

export function SheafRowView({ row }: { row: SheafRow }) {
  return (
    <div className="wall-sheaf-row" data-project-uri={row.projectUri}>
      <div className="wall-sheaf-name">
        <ProjectTag name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
      </div>
      <div className="wall-sheaf-cost" title={`$${row.costUsd.toFixed(2)} in this window`}>
        ${row.costUsd.toFixed(2)}
      </div>
      <div className="wall-sheaf-sub">
        <span>{row.conversations} conv</span>
        <TreeBar trees={row.trees} />
        <span>
          {row.trees} tree{row.trees === 1 ? '' : 's'}
        </span>
        <span>
          {formatTokens(row.inputTokens)} in / {formatTokens(row.outputTokens)} out
        </span>
        {row.unmergedCommits > 0 && (
          <span className="wall-sheaf-warn" title="Commits on worktree branches that are not in origin/main">
            {row.unmergedCommits} unmerged
          </span>
        )}
        {row.alerts.length > 0 && (
          <span className="wall-sheaf-bad" title="Git escalation alerts from the SOTU scan">
            {row.alerts.join(' ')}
          </span>
        )}
        <span className="flex-1" />
        <span
          className="wall-sheaf-rail"
          style={{ width: `${row.costShare * 34 + 6}px`, background: row.projectColor ?? 'var(--border-strong)' }}
        />
      </div>
    </div>
  )
}

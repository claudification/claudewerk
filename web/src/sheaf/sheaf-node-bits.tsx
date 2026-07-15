/**
 * Sheaf node row sub-blocks: the recap/description/summary block and the
 * worktree/commit tag chips. Split from sheaf-tree.tsx (row/tree composition
 * lives there).
 */

import type { SheafNode } from '@shared/sheaf-types'

// Per-conversation recap/description/summary, mirroring the layout of
// web/src/components/project-list/conversation-item-full.tsx: description,
// recap title, then summary OR the away-summary recap (fresh = boxed, stale = dim).
// fallow-ignore-next-line complexity
export function RecapBlock({ node }: { node: SheafNode }) {
  const { description, recap, recapFresh, summary } = node
  if (!description && !recap && !summary) return null
  return (
    <>
      {description && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/60 truncate italic" title={description}>
          {description}
        </div>
      )}
      {recap?.title && <div className="mt-0.5 text-[10px] text-zinc-400/80 truncate">{recap.title}</div>}
      {summary ? (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={summary}>
          {summary}
        </div>
      ) : (
        recap && (
          <div
            className={`mt-1.5 text-[10px] whitespace-pre-wrap overflow-hidden ${
              recapFresh
                ? 'text-zinc-300/80 border-l-2 border-zinc-500/50 pl-2 py-0.5 bg-zinc-800/20 rounded-r'
                : 'text-muted-foreground/50 italic pl-1'
            }`}
            title={recap.content}
          >
            {recap.content}
          </div>
        )
      )}
    </>
  )
}

/** Row 1 tags: worktree name + the (git-fabric) ahead-of-origin commit count. */
export function NodeTags({ node }: { node: SheafNode }) {
  return (
    <>
      {node.worktreeName && (
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 font-mono">
          wt:{node.worktreeName}
        </span>
      )}
      {node.commits > 0 && (
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono"
          title={`${node.commits} commit${node.commits === 1 ? '' : 's'} ahead of origin/main on this worktree's branch (unmerged)`}
        >
          ↑{node.commits}
        </span>
      )}
    </>
  )
}

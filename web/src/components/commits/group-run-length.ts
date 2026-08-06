/**
 * Run-length grouping for the commit browser.
 *
 * CHRONOLOGY IS THE SPINE; GROUPING IS VISUAL DECLUTTERING ONLY. Nothing is
 * reordered. We walk the already-sorted list and start a new header whenever
 * (project, conversation) differs from the previous row -- so the SAME project
 * appears again further down the timeline, which is correct and intended:
 *
 *   PROJECT A
 *     conv-1   commit 1, commit 2
 *   PROJECT B
 *     conv-2   commit 3
 *   PROJECT A          <- again, because time moved on
 *     conv-3   commit 4
 *
 * A `groupBy(project)` would collapse those two PROJECT A blocks into one and
 * destroy the timeline, which is the entire reason the view exists.
 */

import type { CommitRow } from '@/lib/commits'

export interface CommitRun {
  /** Stable key: first commit's hash is unique per run and never reused. */
  key: string
  projectUri: string
  conversationId: string | null
  commits: CommitRow[]
  /** True when the previous run had the same project -- lets the renderer keep
   *  the project header but visually tie the two together. */
  continuesProject: boolean
}

export function groupIntoRuns(commits: CommitRow[]): CommitRun[] {
  const runs: CommitRun[] = []
  for (const commit of commits) {
    const last = runs[runs.length - 1]
    const sameRun = last && last.projectUri === commit.repoUri && last.conversationId === commit.conversationId
    if (sameRun) {
      last.commits.push(commit)
      continue
    }
    runs.push({
      key: `${commit.repoUri}:${commit.conversationId ?? 'terminal'}:${commit.hash}`,
      projectUri: commit.repoUri,
      conversationId: commit.conversationId,
      commits: [commit],
      continuesProject: Boolean(last && last.projectUri === commit.repoUri),
    })
  }
  return runs
}

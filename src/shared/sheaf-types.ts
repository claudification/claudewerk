/**
 * Sheaf -- 24/48h fleet overview.
 *
 * One screen, grouped by project, with spawn forests + rollups. See
 * `.claude/docs/plan-sheaf.md` for the design.
 *
 * Read-side aggregation only -- no new persistence. All inputs already live
 * in the broker (conversations + parent/root cols, turns, termination NDJSON,
 * in-memory live status).
 */

export type SheafStatus = 'running' | 'idle' | 'ended' | 'killed' | 'crashed'

export interface SheafTokens {
  input: number
  output: number
  cache: number
}

export interface SheafCost {
  amount: number
  /** True when ANY turn rolled into this number had `exactCost=0` (PTY estimate). */
  estimated: boolean
}

export interface SheafNode {
  id: string
  title: string
  status: SheafStatus
  scope: string
  startedAt: number
  endedAt: number | null
  /** Wall duration from start to end (or now). */
  durationMs: number
  tokens: SheafTokens
  cost: SheafCost
  /** Highest-cost model in the window. Null when no turns were recorded. */
  model: string | null
  /** Worktree name if currentPath is inside `.claude/worktrees/<name>` or
   *  `.worktrees/<name>`. Null = main checkout / unknown. */
  worktreeName: string | null
  /** Commits attributed to this conversation in the window (phase 3). */
  commits: number
  /** Outcome line: short, one-liner. Recap > termination reason > status hint. */
  outcomeLine: string
  /** Termination reason if ended/killed/crashed. */
  terminationReason: string | null
  /** Direct children (already rolled into the same window). Sorted by startedAt. */
  children: SheafNode[]
  /** Sum across self + descendants. */
  treeTotals: {
    tokens: SheafTokens
    cost: SheafCost
    /** max(end or now) - min(start) across the tree. Wall, not summed. */
    durationWallMs: number
    convCount: number
  }
}

export interface SheafWorktreeSubtotal {
  /** Worktree name, or null for "(main)". */
  name: string | null
  convCount: number
  tokens: SheafTokens
  cost: SheafCost
}

export interface SheafProject {
  /** Canonicalized project URI (worktree-collapsed). Stable bucket key. */
  projectUri: string
  /** Display label (last path segment). */
  label: string
  worktrees: SheafWorktreeSubtotal[]
  forest: SheafNode[]
  totals: {
    tokens: SheafTokens
    cost: SheafCost
    convCount: number
    treeCount: number
  }
}

export interface SheafResponse {
  windowH: number
  windowStart: number
  windowEnd: number
  generatedAt: number
  totals: {
    projects: number
    conversations: number
    trees: number
    tokens: SheafTokens
    cost: SheafCost
  }
  projects: SheafProject[]
}

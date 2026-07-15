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

import type { BranchFabric, GitAlert, SheafGrounding } from './protocol'

// Re-exported so the Sheaf web layer (sheaf-sotu.tsx) consumes the git-fabric
// shapes + the grounding metric from one module alongside the SOTU enrichment
// types. `SheafGrounding` lives in protocol.ts (the wire home) since the Phase-7
// `sotu_eval` result carries it too.
export type { BranchFabric, GitAlert, SheafGrounding } from './protocol'

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
  /** Ahead-of-origin commit count on this node's WORKTREE branch, from SOTU's
   *  git-fabric scan (Phase 6 finishes the formerly-dead `commits: 0 // phase 3`
   *  column). Per-WORKTREE, not per-conversation: every conv sharing a worktree
   *  shows the same count (a precise convId->commit map is not measurable -- the
   *  same honest limit the Phase-4 decay decision documented). 0 = main checkout,
   *  no git-fabric, or branch already integrated. */
  commits: number
  /** Outcome line: short, one-liner. Recap > termination reason > status hint. */
  outcomeLine: string
  /** Termination reason if ended/killed/crashed. */
  terminationReason: string | null
  /** Per-conversation away-summary recap (CC recaps), saved on the conversation. */
  recap: { content: string; title?: string; timestamp: number } | null
  /** True when no meaningful activity happened after the recap was written. */
  recapFresh: boolean
  /** User/agent-set description of the conversation. */
  description: string | null
  /** Short conversation summary (distinct from the away-summary recap). */
  summary: string | null
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

/** SOTU enrichment attached to one project section in the fleet view (Phase 6).
 *  ALWAYS present on a project the viewer may see (free floor: alerts + contended
 *  + git-fabric branches, zero LLM); `narrative` is the PAID chronicle prose,
 *  present only when the project opted in AND a distill has run. Absent entirely
 *  on a project the viewer cannot see (the per-project visibility filter -- no
 *  chronicle bleed across project boundaries). */
export interface SheafProjectSotu {
  /** Project opted into the paid distill (`ProjectSettings.sotuEnabled`). */
  enabled: boolean
  /** Distilled "where are we" prose, trimmed. Absent when disabled / never distilled. */
  narrative?: string
  /** When the chronicle was generated (epoch ms). Absent until the first distill. */
  generatedAt?: number
  /** Deduped git escalation alerts (at-risk/unpushed/stalled) for this project. */
  alerts: GitAlert[]
  /** Count of CONTENDED targets (2+ convs on one claim/stake) -- passive collision. */
  contended: number
  /** Per-branch/worktree merge-risk from the latest git-fabric scan (free, always-on). */
  branches: BranchFabric[]
  /** Fetch freshness of the git-fabric snapshot ("origin/main as of <t>"). */
  fetchedAt?: number
  /** When the git-fabric was scanned (epoch ms). */
  scannedAt?: number
  /** Citation-grounding of the chronicle vs its input (present only when distilled). */
  grounding?: SheafGrounding
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
  /** SOTU narrative + git-fabric + claims/stakes. Set by the Phase-6 fleet
   *  enrichment AFTER the structural build. Absent when the viewer cannot see
   *  this project (visibility filter) or the SOTU store is unavailable. */
  sotu?: SheafProjectSotu
}

/** The cheap fleet rollup (Phase 6): a zero-LLM UNION across the projects the
 *  viewer can see -- total git alerts, contention, grounding average. The optional
 *  LLM "fleet narrative" (on-return) is a later add; this union is always free. */
export interface SheafFleetSotu {
  /** Projects (visible) that opted into the paid distill. */
  projectsEnabled: number
  /** Projects (visible) with a non-empty distilled narrative. */
  projectsWithNarrative: number
  /** Deduped union of git alerts across visible projects. */
  alerts: GitAlert[]
  /** Total CONTENDED targets across visible projects. */
  contended: number
  /** Visible projects carrying each alert class (the fleet risk counts). */
  atRiskProjects: number
  unpushedProjects: number
  stalledProjects: number
  unmergedProjects: number
  /** Input-weighted average grounding across distilled visible projects. Absent
   *  when no visible project has a distilled chronicle. */
  grounding?: SheafGrounding
  /** Projects hidden from this viewer by the per-project visibility filter. Surfaced
   *  (never silently dropped) so the view never reads as "the whole fleet" when it
   *  is a filtered slice. */
  filteredProjects: number
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
  /** Fleet-wide SOTU union (Phase 6). Set by the enrichment; absent when the SOTU
   *  store is unavailable. Reflects ONLY the projects this viewer may see. */
  sotu?: SheafFleetSotu
}

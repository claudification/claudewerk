/**
 * NIGHTSHIFT shared types -- the on-disk artifact schema (plan §3) projected as
 * TypeScript. The `.nightshift/` tree is the API: screens are viewers, agents
 * get pointed at the folder. These types are the single source of truth for the
 * frontmatter the sentinel writes and the control panel reads.
 *
 * Storage shape (owned by src/shared/nightshift-store.ts):
 *   <project>/.nightshift/
 *     config.json
 *     runs/<runId>/run.md            run-level frontmatter + digest body
 *     runs/<runId>/tasks/NNN-*.md    one file per ready/errored/done task
 *     runs/<runId>/blocked/NNN-*.md  refinement questions awaiting Jonas
 *     runs/<runId>/skipped.md        declined tasks + why (one section each)
 *     latest -> runs/<runId>         symlink: "point the agent here"
 *
 * runId is the run DATE (YYYY-MM-DD): one run per night, deterministic dir name.
 */

// ---------------------------------------------------------------------------
// Task lifecycle vocabulary
// ---------------------------------------------------------------------------

/** Terminal (or near-terminal) state of a single nightshift task. */
export type NightshiftTaskStatus = 'queued' | 'running' | 'done' | 'blocked' | 'errored' | 'skipped' | 'spinning'

/** What the morning report should DO with this task. */
export type NightshiftVerdict = 'ready-to-review' | 'needs-you' | 'declined'

/**
 * THE TRUST BACKBONE (Jonas directive #2). Before running ANY task the agent
 * answers "is this safe to do -- can it plausibly accomplish the goal at all?"
 * Default instinct = decline. An `infeasible` verdict is flagged IMMEDIATELY
 * (skipped.md entry + reason) and the run carries on -- never a 2h unsupervised
 * burn on something it can't actually do.
 */
export type NightshiftFeasibility = 'feasible' | 'uncertain' | 'infeasible'

/** Acceptance-test outcome recorded back into the artifact. */
export type NightshiftTests = 'pass' | 'fail' | 'none'

export type NightshiftRisk = 'low' | 'medium' | 'high'

// ---------------------------------------------------------------------------
// Task file frontmatter (plan §3)
// ---------------------------------------------------------------------------

export interface NightshiftTaskMeta {
  /** Zero-padded ordinal within the run, e.g. "002". Drives file name + sort. */
  id: string
  title: string
  /** Project URI or slug the task belongs to. */
  project: string
  status: NightshiftTaskStatus
  verdict: NightshiftVerdict
  /** Feasibility verdict from the pre-run safe-to-do gate. */
  feasibility: NightshiftFeasibility
  /** Worktree branch the work landed on (absent until work starts). */
  branch?: string
  base?: string
  commits?: number
  /** e.g. "+31 -6". */
  diffstat?: string
  files?: string[]
  /** Concrete, verifiable acceptance criteria for the task. */
  acceptance?: string
  tests?: NightshiftTests
  risk?: NightshiftRisk
  /** resolvedProfile the task ran under (the capacity truth, not URI userinfo). */
  profile?: string
  reroutes?: number
  attempts?: number
  tokens?: number
  cost_usd?: number
  duration_min?: number
  /** ISO timestamp the task file was first written. */
  created: string
}

/** Full task artifact: frontmatter + the markdown body sections. */
export interface NightshiftTask extends NightshiftTaskMeta {
  /** Everything below the `---` fence (What it did / How to verify / Notes / Open loops). */
  body: string
}

/**
 * The body the agent supplies when reporting. The store renders it into the
 * canonical section layout so every task file reads the same.
 */
export interface NightshiftTaskReport {
  /** One-paragraph recap of what the task did (or why it declined). */
  recap?: string
  /** Command(s) to verify the work. */
  howToVerify?: string
  /** Any non-obvious call the agent made. */
  notes?: string
  /** Outstanding follow-ups; empty => "none". */
  openLoops?: string[]
}

// ---------------------------------------------------------------------------
// Blocked-lane entry (refinement question awaiting Jonas)
// ---------------------------------------------------------------------------

export interface NightshiftBlocked {
  id: string
  title: string
  project: string
  /** The crisp async question the agent parked. */
  question: string
  /** Optional A/B/... choices; an open-thread question has none. */
  options?: string[]
  created: string
  body: string
}

// ---------------------------------------------------------------------------
// Skipped-lane entry (declined + why -- trust isn't eroded by silent drops)
// ---------------------------------------------------------------------------

export interface NightshiftSkipped {
  id: string
  title: string
  project: string
  /** Why it was declined (feasibility reason or explicit cut). */
  reason: string
  feasibility: NightshiftFeasibility
  created: string
}

// ---------------------------------------------------------------------------
// Run-level frontmatter + digest (run.md)
// ---------------------------------------------------------------------------

export interface NightshiftRunTotals {
  ready: number
  blocked: number
  skipped: number
  errored: number
}

export interface NightshiftRunMeta {
  /** Run identifier == the run date, YYYY-MM-DD. */
  runId: string
  date: string
  status: 'running' | 'done'
  totals: NightshiftRunTotals
  /** Total task count dispatched this run. */
  taskCount: number
  /** Wall-clock runtime in minutes (filled at finalize). */
  runtime_min?: number
  cost_usd?: number
  /** resolvedProfile names used across the run. */
  profiles?: string[]
  /** Scheduling window string, e.g. "01:00-07:00". */
  window?: string
  created: string
  /** ISO timestamp the run was finalized. */
  finished?: string
}

/** The full run.md: frontmatter + the 5-line Advisor digest body. */
export interface NightshiftRun extends NightshiftRunMeta {
  /** The digest -- the night in one glance. */
  digest: string
}

/** Everything the Result screen needs for the latest run, in one payload. */
export interface NightshiftRunSnapshot {
  run: NightshiftRun
  tasks: NightshiftTaskMeta[]
  blocked: NightshiftBlocked[]
  skipped: NightshiftSkipped[]
}

// ---------------------------------------------------------------------------
// config.json (per-project nightshift config, plan §2.2 + §10)
// ---------------------------------------------------------------------------

/**
 * Unattended permission model (plan §10). `auto` = managed classifier,
 * `dontAsk` = locked-down allow-list, `bypassPermissions` = ephemeral hosts only.
 */
export type NightshiftPermissionMode = 'auto' | 'dontAsk' | 'bypassPermissions'

export interface NightshiftCaps {
  /** Max concurrent tasks. */
  concurrency?: number
  /** Firehose guard: max tasks dispatched per run. */
  totalTasks?: number
  /** Per-task wall-clock ceiling in minutes. */
  perTaskMinutes?: number
}

export interface NightshiftConfig {
  /** Master switch for this project. */
  enabled: boolean
  /** Scheduling window, e.g. "01:00-07:00" or "interactive load < X". */
  window?: string
  /** resolvedProfile names allowed to run background work. */
  profilesAllowed?: string[]
  caps?: NightshiftCaps
  /** v1 default: branch-for-review (plan §8 decision #1 -- PARKED, not auto-merge). */
  mergePolicy: 'branch-for-review' | 'auto-merge-if-green'
  /** Unattended permission mode (plan §10). */
  permissionMode: NightshiftPermissionMode
  /** Per-project allow rules (for dontAsk mode). */
  allow?: string[]
  /** Per-project deny rules layered on top of the always-on deny-floor. */
  deny?: string[]
}

/** Recommended defaults (plan §8 PARKED decisions resolved to the rec values). */
export const DEFAULT_NIGHTSHIFT_CONFIG: NightshiftConfig = {
  enabled: false,
  mergePolicy: 'branch-for-review',
  permissionMode: 'dontAsk',
  caps: { concurrency: 2, totalTasks: 8, perTaskMinutes: 120 },
}

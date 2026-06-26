/**
 * SOTU (State of the Union) domain types.
 *
 * SOTU is a per-project + fleet, auto-maintained, decaying briefing -- the
 * "where are we / where do I look" narrative. The full design lives in
 * `.claude/docs/plan-state-of-union.md`.
 *
 * Two layers:
 *   LAYER 1  CONTRIBUTIONS -- raw, free, no-LLM append-only queue (this file's
 *            `Contribution` union). Four sources: callouts (declared intent),
 *            turn-digests (per-turn baseline), git-scans (derived state),
 *            lifecycle (spawn/exit/...). Yields the live soft-lock map alone.
 *   LAYER 2  CHRONICLE -- the distilled narrative (`Chronicle`), regenerated
 *            lazily by the scribe/reconcile fold (Phase 4). Budget-gated.
 *
 * Phase 0 defines the shapes + the file-store that persists them; the handlers,
 * git scan, and distill engine that PRODUCE them land in later phases.
 *
 * Boundary: every id here is a broker-owned conversation id, NEVER ccSessionId.
 */

// The callout/claim shapes are the WIRE contract -- they live in
// `src/shared/protocol.ts` (the single source of truth) and are re-exported here
// so the broker module consumes them without duplicating the union. `scribe_note`
// (the wire message) carries the same `noteType`/`weight`/`target` fields.
import type { CalloutType, ContribWeight, ScribeNoteTarget } from '../../shared/protocol'

export type { CalloutType, ContribWeight, ScribeNoteTarget } from '../../shared/protocol'

// ─── Contribution queue (Layer 1, queue.jsonl) ──────────────────────

interface ContribBase {
  /** Broker-owned source conversation id (never ccSessionId). */
  convId: string
  /** Epoch ms when emitted. */
  ts: number
  /** Optional time-to-live in ms. The entry is "expired" once ts + ttlMs < now
   *  (the free soft-lock map reads only non-expired entries). Omit = no expiry. */
  ttlMs?: number
}

/** Declared intent -- the gold, not derivable. Emitted inline as `<callout>` and
 *  collected by the agent host (the only component allowed to parse CC output). */
export interface CalloutContrib extends ContribBase {
  kind: 'callout'
  type: CalloutType
  payload: string
  weight: ContribWeight
  /** Present when the callout is a claim/stake (soft-coordination layer). */
  target?: ScribeNoteTarget
}

/** Per-turn baseline -- a compact digest, NOT raw messages. The scribe's main
 *  feed; guarantees coverage even when no callout is emitted. */
export interface TurnDigestContrib extends ContribBase {
  kind: 'turn_digest'
  intent?: string
  touching?: string[]
  result?: string
  blockedOn?: string
}

/** Derived state -- the git-fabric scan snapshot (Phase 2), appended debounced. */
export interface GitScanContrib extends ContribBase {
  kind: 'git_scan'
  git: GitFabric
}

/** Lifecycle event the broker already emits (the deterministic floor). The values
 *  mirror the broker's in-process desk-event vocabulary (`created` = spawn/open,
 *  `ended` = exit/terminate/complete, `resumed` = revive) -- the floor consumes
 *  those events verbatim rather than inventing a parallel taxonomy. */
export interface LifecycleContrib extends ContribBase {
  kind: 'lifecycle'
  event: 'created' | 'ended' | 'resumed'
}

export type Contribution = CalloutContrib | TurnDigestContrib | GitScanContrib | LifecycleContrib

// ─── Git fabric (derived state -- Phase 2 produces it) ──────────────

/** Integration status of a branch vs origin/main, from one `merge-tree` run.
 *  integrated -> work absorbed (decays); conflicts -> needs a human merge. */
export type IntegrationStatus = 'integrated' | 'ff-clean' | 'merge-clean' | 'conflicts'

/** Escalation alerts from the SAME scan (opposite of decay). */
export type GitAlert = 'at-risk' | 'unpushed' | 'stalled'

export interface BranchFabric {
  branch: string
  worktree?: string
  /** ahead/behind reported vs BOTH origin/main and local main. */
  aheadOrigin: number
  behindOrigin: number
  aheadLocal: number
  behindLocal: number
  integration: IntegrationStatus
  /** Conflicting paths when integration === 'conflicts'. */
  conflictFiles?: string[]
  alerts: GitAlert[]
}

/** A timestamped snapshot. Integration claims are only as fresh as the last
 *  fetch -- `fetchedAt` stamps "origin/main as of <t>"; `scannedAt` stamps the
 *  scan. Refs mutate mid-scan in this hot multi-worktree repo. */
export interface GitFabric {
  branches: BranchFabric[]
  fetchedAt?: number
  scannedAt: number
}

// ─── Chronicle (Layer 2, chronicle.json + chronicle.md) ─────────────

export interface ChronicleEntry {
  convId: string
  title?: string
  detail: string
  ts: number
}

/** The distilled SOTU. `now`/`justDone` are structured; `narrative` is the
 *  human "where are we" rollup. Regenerated lazily by the distill engine. */
export interface Chronicle {
  /** Conversations running right now + what they declared. */
  now: ChronicleEntry[]
  /** Exited/terminated convs with final state + age. */
  justDone: ChronicleEntry[]
  /** Human "where are we" prose. */
  narrative: string
  /** Latest git-fabric snapshot folded in by the reconcile pass. */
  git?: GitFabric
  /** Pipeline version this chronicle was generated against (recap C++ replay
   *  gate -- refuse to fold across an incompatible schema). */
  pipelineVersion: number
  /** Epoch ms the chronicle was generated. */
  generatedAt: number
}

// ─── State (state.json -- trigger bookkeeping) ──────────────────────

/** Per-project trigger state. The activity-driven trigger (Phase 4) reads/writes
 *  this; the free floor never needs an LLM call to keep it current. */
export interface SotuState {
  /** Epoch ms of the last distill (MIN_INTERVAL cost floor reads this). */
  lastDistillAt: number
  /** Weighted count of contributions since the last distill (intent=3,
   *  lifecycle=2, git-snap=1). BURST_THRESHOLD reads this. */
  pendingContribs: number
  /** Epoch ms the chronicle was last generated (STALE_ON_READ reads this). */
  genAt: number
  /** Schema version of the persisted chronicle/state. */
  pipelineVersion: number
}

/** Bump when the persisted chronicle/state/queue shapes change incompatibly.
 *  Mirrors recap's RECAP_LEDGER_VERSION / pipelineVersion replay gate. */
export const SOTU_PIPELINE_VERSION = 1

/** A fresh-project state with no contributions and no chronicle yet. */
export function emptyState(): SotuState {
  return {
    lastDistillAt: 0,
    pendingContribs: 0,
    genAt: 0,
    pipelineVersion: SOTU_PIPELINE_VERSION,
  }
}

/** An empty chronicle (no convs, no narrative) -- the default read before any
 *  distill has run. The free floor still renders the live queue on top of this. */
export function emptyChronicle(generatedAt = 0): Chronicle {
  return {
    now: [],
    justDone: [],
    narrative: '',
    pipelineVersion: SOTU_PIPELINE_VERSION,
    generatedAt,
  }
}

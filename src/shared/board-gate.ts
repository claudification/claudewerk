/**
 * DETERMINISTIC DONE-GATE (Quest Engine §2, plan-evidence-board Tier-1/Tier-2).
 *
 * `project_set_status` moves board cards on the agent's say-so. This module makes
 * the transition to `in-review`/`done` EARN itself with dumb machine checks no
 * model can lie past (Tier-2, board-gate-checks.ts), plus an independent-verdict
 * requirement (Tier-1: a card's worker cannot approve its own card).
 *
 * Evidence is MACHINE-AUTHORED at transition time (§3): branch/base/commits/
 * diffstat/tests + the worker/approver conversation ids come from git and
 * `ctx.getIdentity()`, never agent text -- so self-approval cannot be spoofed.
 *
 * The public surface is pure (runners injected). The Bun-backed git/cmd runners +
 * frontmatter write-back live in project-board.ts; the agent host owns the cwd +
 * git, the broker never touches the filesystem (boundary covenant).
 */

import { approvalEvidence, type GateCheck, type GateInput, runTier1, runTier2, str } from './board-gate-checks'
import type { TaskStatus } from './task-statuses'

export type { CmdResult, CmdRunner, GateCheck, GateInput, GitResult, GitRunner } from './board-gate-checks'

export type GateMode = 'off' | 'tier2' | 'full'
/** Exported so `card-schema-keys.ts` declares the `gate:` key's enum from THIS
 *  list rather than a second copy of it. */
export const GATE_MODES: readonly GateMode[] = ['off', 'tier2', 'full']
const GATED_TARGETS: readonly TaskStatus[] = ['in-review', 'done']

export interface GateOutcome {
  /** allow = proceed; refuse = block with reason; skip = gate off / not applicable. */
  decision: 'allow' | 'refuse' | 'skip'
  mode: GateMode
  /** Precise, agent-actionable reason when refused (e.g. "tree dirty: 3 changed files"). */
  reason?: string
  checks: GateCheck[]
  /** Frontmatter keys to merge into the card on `allow` (machine-authored evidence). */
  evidence: Record<string, unknown>
}

export function isGateMode(v: unknown): v is GateMode {
  return typeof v === 'string' && (GATE_MODES as readonly string[]).includes(v)
}

/** Lanes the gate has an opinion about. Everything else transitions ungated. */
export function isGatedTarget(status: TaskStatus): boolean {
  return GATED_TARGETS.includes(status)
}

/**
 * Resolve the effective gate mode for a card. Precedence:
 *   1. per-card `gate:` frontmatter override (explicit)
 *   2. quest cards (`quest:` present) default to `full`
 *   3. per-project config (default `off` -- current behavior, non-quest boards unbroken)
 */
export function resolveGateMode(meta: Record<string, unknown>, projectConfigMode?: GateMode): GateMode {
  if (isGateMode(meta.gate)) return meta.gate
  if (str(meta.quest)) return 'full'
  return projectConfigMode ?? 'off'
}

/**
 * Evaluate the gate for one transition. `skip` when the mode is off or the target
 * is not gated; otherwise Tier-2 always, plus Tier-1 for `full` + target `done`.
 * Async because Tier-2 runs the card's `test_cmd` through an async `CmdRunner` --
 * a sync runner froze the calling conversation's MCP host for the whole suite.
 * On `in-review` the acting conversation is stamped as the card's worker so a
 * later `done` can prove the approver is a different conversation.
 */
export async function evaluateGate(input: GateInput, mode: GateMode): Promise<GateOutcome> {
  if (mode === 'off' || !isGatedTarget(input.targetStatus)) {
    return { decision: 'skip', mode, checks: [], evidence: {} }
  }

  const t2 = await runTier2(input)
  const checks = [...t2.checks]
  const evidence = { ...t2.evidence }
  if (!t2.ok) {
    return { decision: 'refuse', mode, reason: reasonFrom(checks), checks, evidence }
  }

  if (mode === 'full' && input.targetStatus === 'done') {
    const t1 = runTier1(input)
    checks.push(t1.check)
    if (!t1.ok) return { decision: 'refuse', mode, reason: t1.check.detail, checks, evidence }
  }

  if (input.targetStatus === 'in-review') {
    // First review capture owns the "worker" slot; preserve it across re-reviews.
    evidence.evidence_worker = str(input.meta.evidence_worker) || input.actingConversationId
  }
  // Every allowed approval leaves a trace, in every mode. Under `full` Tier-1
  // has just PROVEN the approver is not the worker; under `tier2` this only
  // records who moved it -- compare against evidence_worker to tell which.
  if (input.targetStatus === 'done') Object.assign(evidence, approvalEvidence(input))

  return { decision: 'allow', mode, checks, evidence }
}

function reasonFrom(checks: GateCheck[]): string {
  return (
    checks
      .filter(c => !c.ok)
      .map(c => c.detail)
      .join('; ') || 'gate check failed'
  )
}

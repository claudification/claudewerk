/**
 * CAPACITY DECISION -- structured-message builder for the ledger (§9 covenant:
 * every reserve/settle/deny/sleep/starve is a structured message + full-context
 * log line). Kept separate so the ledger stays focused on the accounting.
 */

import { randomUUID } from 'node:crypto'
import type { CapacityDecision, CapacityVerdict } from '../shared/protocol'
import type { TaskCtx } from './capacity-types'

export interface DecisionInput {
  ctx: TaskCtx
  profile: string
  verdict: CapacityVerdict
  at: number
  reason: string
  estimateTokens?: number
  headroomTokens?: number
  outstandingTokens?: number
  floorTokens?: number
  availableTokens?: number
  fiveHourPct?: number
  sleepUntil?: number
}

/** Build the flat, JSON-safe wire decision + write the full-context log line,
 *  then hand it to `emit` (broadcast + persist). */
export function recordDecision(emit: (d: CapacityDecision) => void, d: DecisionInput): void {
  const decision: CapacityDecision = {
    id: `cap-${randomUUID()}`,
    at: d.at,
    project: d.ctx.project,
    runId: d.ctx.runId,
    taskId: d.ctx.taskId,
    profile: d.profile,
    verdict: d.verdict,
    reason: d.reason,
    estimateTokens: d.estimateTokens,
    headroomTokens: round(d.headroomTokens),
    outstandingTokens: round(d.outstandingTokens),
    floorTokens: round(d.floorTokens),
    availableTokens: round(d.availableTokens),
    fiveHourPct: d.fiveHourPct === undefined ? undefined : Math.round(d.fiveHourPct),
    sleepUntil: d.sleepUntil,
  }
  console.log(
    `[capacity-ledger] ${d.verdict} project=${d.ctx.project} run=${d.ctx.runId} task=${d.ctx.taskId} ` +
      `profile=${d.profile} ${d.reason}`,
  )
  emit(decision)
}

function round(n?: number): number | undefined {
  return n === undefined ? undefined : Math.round(n)
}

/** Locale-formatted token count for human-readable reasons. */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

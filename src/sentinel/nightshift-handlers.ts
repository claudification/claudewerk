/**
 * Sentinel handlers for the NIGHTSHIFT artifact RPCs. The dispatch in index.ts
 * resolves `projectRoot` (expandPath against spawnRoot) and calls
 * `handleNightshiftOp` with the absolute root; every path op below is jailed
 * under it by src/shared/nightshift-store.ts.
 *
 * One op-envelope in (NightshiftOp), one result out (NightshiftResult) -- mirrors
 * project-handlers.ts. The sentinel is the SOLE writer of `.nightshift/`, so the
 * morning Result screen works with zero live agent hosts.
 */

import {
  appendSkipped,
  finalizeRun,
  readLatestSnapshot,
  readNightshiftConfig,
  readRunSnapshot,
  startRun,
  writeBlocked,
  writeNightshiftConfig,
  writeTask,
} from '../shared/nightshift-store'
import type { NightshiftReportInput } from '../shared/nightshift-types'
import type { NightshiftOp, NightshiftResult } from '../shared/protocol'

/** Write one task/blocked/skipped artifact and shape the result. */
function handleReport(root: string, runId: string, report: NightshiftReportInput, nowMs: number): NightshiftResult {
  const base = { type: 'nightshift_result' as const, requestId: '', op: 'report' as const }
  switch (report.kind) {
    case 'task': {
      const task = writeTask(
        root,
        runId,
        {
          id: report.id,
          title: report.title,
          project: report.project,
          status: report.status ?? 'done',
          verdict: report.verdict ?? 'needs-you',
          feasibility: report.feasibility ?? 'feasible',
          branch: report.branch,
          base: report.base,
          commits: report.commits,
          diffstat: report.diffstat,
          files: report.files,
          acceptance: report.acceptance,
          tests: report.tests,
          risk: report.risk,
          profile: report.profile,
          reroutes: report.reroutes,
          attempts: report.attempts,
          tokens: report.tokens,
          cost_usd: report.cost_usd,
          duration_min: report.duration_min,
          report: report.taskReport,
        },
        nowMs,
      )
      return { ...base, ok: true, task }
    }
    case 'blocked': {
      const blocked = writeBlocked(
        root,
        runId,
        {
          id: report.id,
          title: report.title,
          project: report.project,
          question: report.question ?? report.title,
          options: report.options,
          body: report.body,
        },
        nowMs,
      )
      return { ...base, ok: true, blocked }
    }
    case 'skipped': {
      const skipped = appendSkipped(
        root,
        runId,
        {
          id: report.id,
          title: report.title,
          project: report.project,
          reason: report.reason ?? 'declined',
          feasibility: report.feasibility ?? 'infeasible',
        },
        nowMs,
      )
      return { ...base, ok: true, skipped }
    }
    default:
      return { ...base, ok: false, error: `unknown report kind: ${(report as { kind: string }).kind}` }
  }
}

export function handleNightshiftOp(root: string, msg: NightshiftOp, nowMs: number): NightshiftResult {
  const base = { type: 'nightshift_result' as const, requestId: msg.requestId, op: msg.op }
  try {
    switch (msg.op) {
      case 'snapshot': {
        const snapshot = msg.runId ? readRunSnapshot(root, msg.runId) : readLatestSnapshot(root)
        return { ...base, ok: true, snapshot }
      }
      case 'config_read':
        return { ...base, ok: true, config: readNightshiftConfig(root) }
      case 'config_write': {
        if (!msg.config) return { ...base, ok: false, error: 'config required' }
        writeNightshiftConfig(root, msg.config)
        return { ...base, ok: true, config: readNightshiftConfig(root) }
      }
      case 'run_start': {
        if (!msg.runStart) return { ...base, ok: false, error: 'runStart required' }
        return { ...base, ok: true, run: startRun(root, msg.runStart, nowMs) }
      }
      case 'report': {
        if (!msg.report) return { ...base, ok: false, error: 'report required' }
        const runId = msg.runId ?? msg.runStart?.runId
        if (!runId) return { ...base, ok: false, error: 'runId required for report' }
        const r = handleReport(root, runId, msg.report, nowMs)
        return { ...r, requestId: msg.requestId }
      }
      case 'run_finalize': {
        if (!msg.runId) return { ...base, ok: false, error: 'runId required for run_finalize' }
        const run = finalizeRun(root, msg.runId, msg.finalize ?? {}, nowMs)
        if (!run) return { ...base, ok: false, error: `run not found: ${msg.runId}` }
        return { ...base, ok: true, run }
      }
      default:
        return { ...base, ok: false, error: `unknown op: ${(msg as NightshiftOp).op}` }
    }
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message }
  }
}

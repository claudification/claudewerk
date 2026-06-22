/**
 * Dispatch audit store -- SQLite log of every routing decision.
 *
 * Decision #11 in plan-front-desk.md ("audit from day one"): every dispatch
 * decision is logged -- input intent, disposition, target, confidence,
 * reasoning, candidates, cost, executed. This is the raw material for the
 * later eval harness (Front Desk Phase 7) and for "why did it route there?".
 *
 * Broker-local config/log data (NOT time-series), so it gets its own durable
 * DB file, mirroring checklist-store.ts's module-singleton shape.
 *
 * Storage: {cacheDir}/dispatch-audit.db
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { DispatchDecision } from '../../shared/protocol'
import { openWalDatabase } from '../sqlite-open'

// ─── Types ──────────────────────────────────────────────────────────

/** SQLite row shape (snake_case). JSON columns hold the structured fields. */
interface DecisionRow {
  decision_id: string
  intent: string
  disposition: string
  target: string | null
  confidence: number
  reasoning: string
  candidates_json: string | null
  cost_json: string | null
  executed: number
  awaiting_confirmation: number
  result_conversation_id: string | null
  trace_id: string
  ts: number
}

function rowToDecision(r: DecisionRow): DispatchDecision {
  const d: DispatchDecision = {
    type: 'dispatch_decision',
    decisionId: r.decision_id,
    intent: r.intent,
    disposition: r.disposition as DispatchDecision['disposition'],
    confidence: r.confidence,
    reasoning: r.reasoning,
    executed: r.executed === 1,
    traceId: r.trace_id,
    ts: r.ts,
  }
  if (r.target !== null) d.target = r.target
  if (r.candidates_json) d.candidates = JSON.parse(r.candidates_json)
  if (r.cost_json) d.cost = JSON.parse(r.cost_json)
  if (r.awaiting_confirmation === 1) d.awaitingConfirmation = true
  if (r.result_conversation_id !== null) d.resultConversationId = r.result_conversation_id
  return d
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsert: Statement | null = null
let stmtList: Statement | null = null
let stmtGet: Statement | null = null

// ─── Init / Shutdown ────────────────────────────────────────────────

export function initDispatchAudit(cacheDir: string): void {
  const dbPath = resolve(cacheDir, 'dispatch-audit.db')
  db = openWalDatabase(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS dispatch_decisions (
      decision_id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      disposition TEXT NOT NULL,
      target TEXT,
      confidence REAL NOT NULL,
      reasoning TEXT NOT NULL,
      candidates_json TEXT,
      cost_json TEXT,
      executed INTEGER NOT NULL DEFAULT 0,
      awaiting_confirmation INTEGER NOT NULL DEFAULT 0,
      result_conversation_id TEXT,
      trace_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_ts ON dispatch_decisions(ts)`)

  stmtInsert = db.prepare(`
    INSERT INTO dispatch_decisions
      (decision_id, intent, disposition, target, confidence, reasoning,
       candidates_json, cost_json, executed, awaiting_confirmation,
       result_conversation_id, trace_id, ts)
    VALUES
      ($decision_id, $intent, $disposition, $target, $confidence, $reasoning,
       $candidates_json, $cost_json, $executed, $awaiting_confirmation,
       $result_conversation_id, $trace_id, $ts)
    ON CONFLICT(decision_id) DO UPDATE SET
      disposition = excluded.disposition,
      target = excluded.target,
      confidence = excluded.confidence,
      reasoning = excluded.reasoning,
      candidates_json = excluded.candidates_json,
      cost_json = excluded.cost_json,
      executed = excluded.executed,
      awaiting_confirmation = excluded.awaiting_confirmation,
      result_conversation_id = excluded.result_conversation_id,
      ts = excluded.ts
  `)
  stmtList = db.prepare(`SELECT * FROM dispatch_decisions ORDER BY ts DESC LIMIT $limit`)
  stmtGet = db.prepare(`SELECT * FROM dispatch_decisions WHERE decision_id = $decision_id`)
}

export function closeDispatchAudit(): void {
  db?.close()
  db = null
  stmtInsert = stmtList = stmtGet = null
}

// ─── Operations ─────────────────────────────────────────────────────

/** Record (or upsert, by decisionId) a dispatch decision. Idempotent so a
 *  decision can be logged at `ask` time and again once executed. */
export function recordDecision(d: DispatchDecision): void {
  if (!stmtInsert) throw new Error('dispatch audit store not initialised')
  stmtInsert.run({
    decision_id: d.decisionId,
    intent: d.intent,
    disposition: d.disposition,
    target: d.target ?? null,
    confidence: d.confidence,
    reasoning: d.reasoning,
    candidates_json: d.candidates ? JSON.stringify(d.candidates) : null,
    cost_json: d.cost ? JSON.stringify(d.cost) : null,
    executed: d.executed ? 1 : 0,
    awaiting_confirmation: d.awaitingConfirmation ? 1 : 0,
    result_conversation_id: d.resultConversationId ?? null,
    trace_id: d.traceId,
    ts: d.ts,
  })
}

/** Most recent decisions first (for the audit view + eval replay). */
export function listDecisions(limit = 50): DispatchDecision[] {
  if (!stmtList) throw new Error('dispatch audit store not initialised')
  return (stmtList.all({ limit }) as DecisionRow[]).map(rowToDecision)
}

export function getDecision(decisionId: string): DispatchDecision | null {
  if (!stmtGet) throw new Error('dispatch audit store not initialised')
  const row = stmtGet.get({ decision_id: decisionId }) as DecisionRow | null
  return row ? rowToDecision(row) : null
}

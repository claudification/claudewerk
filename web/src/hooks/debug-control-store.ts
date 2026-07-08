/**
 * Ephemeral store for control-debug traces (the debug modal's live log).
 *
 * Outside Zustand (like thinking-progress-store). Each `debug_control_send` the
 * modal fires starts a trace; `debug_trace_event` breadcrumbs and the final
 * `debug_control_result` stream in and append to it. The modal renders the
 * waterfall + result. Capped ring; cleared on demand.
 */

import { createExternalStoreSignal } from './external-store-utils'

export interface DebugTraceRow {
  seam: string
  t: number
  ok?: boolean
  detail?: string
  raw?: unknown
}

export interface DebugTraceResult {
  ok: boolean
  response?: unknown
  error?: string
  code?: string
  elapsedMs: number
}

export interface DebugTrace {
  traceId: string
  conversationId: string
  channel: string
  command: string
  sentAt: number
  events: DebugTraceRow[]
  result?: DebugTraceResult
}

const MAX_TRACES = 50
const traces: DebugTrace[] = []
const byId = new Map<string, DebugTrace>()
const signal = createExternalStoreSignal()

export function startDebugTrace(t: {
  traceId: string
  conversationId: string
  channel: string
  command: string
}): void {
  const trace: DebugTrace = {
    ...t,
    sentAt: Date.now(),
    events: [{ seam: 'web_send', t: Date.now(), detail: `${t.channel}:${t.command}` }],
  }
  traces.push(trace)
  byId.set(trace.traceId, trace)
  while (traces.length > MAX_TRACES) {
    const old = traces.shift()
    if (old) byId.delete(old.traceId)
  }
  signal.bump()
}

export function addDebugTraceEvent(traceId: string, row: DebugTraceRow): void {
  const tr = byId.get(traceId)
  if (!tr) return
  tr.events.push(row)
  signal.bump()
}

export function setDebugTraceResult(traceId: string, result: DebugTraceResult): void {
  const tr = byId.get(traceId)
  if (!tr) return
  tr.result = result
  signal.bump()
}

export function clearDebugTraces(conversationId: string): void {
  for (let i = traces.length - 1; i >= 0; i--) {
    if (traces[i].conversationId === conversationId) {
      byId.delete(traces[i].traceId)
      traces.splice(i, 1)
    }
  }
  signal.bump()
}

/** Recent traces for a conversation, newest first. */
export function getDebugTraces(conversationId: string): DebugTrace[] {
  return traces.filter(t => t.conversationId === conversationId).reverse()
}

/** The final result for a single trace, or undefined until it lands. Lets a
 *  caller (e.g. the Login modal) await one command's outcome without scanning. */
export function getDebugTraceResult(traceId: string): DebugTraceResult | undefined {
  return byId.get(traceId)?.result
}

export const subscribe = signal.subscribe
export const getVersion = signal.getVersion

/**
 * Nightshift watchdog decision-log RPC: the live Status screen (§2.5) asks the
 * broker for a project's recent watchdog decisions on mount (backfill); the live
 * feed thereafter arrives as `nightshift_watchdog_event` broadcasts from the
 * watchdog loop itself.
 *
 * Broker-LOCAL read: the decision ring lives in `nightshift-watchdog-log.ts`,
 * not on disk and not on the sentinel -- so this handler answers directly, no
 * sentinel round-trip. Scoped to the control panel + benevolent agents
 * (CONTROL_PANEL_ONLY) and gated on `files:read` for the project, mirroring the
 * `.nightshift/` artifact RPC.
 */

import type { NightshiftWatchdogRequest } from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'
import { getRecentWatchdogDecisions } from '../nightshift-watchdog-log'

const MAX_LIMIT = 500

const watchdogRequest: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const d = data as unknown as NightshiftWatchdogRequest
  if (!d.project || !d.requestId) return

  // Reading the decision log exposes which night tasks ran in this project.
  // Throws GuardError on denial (router catches + replies with an error).
  ctx.requirePermission('files:read', d.project)

  const limit = Math.min(Math.max(1, d.limit ?? 200), MAX_LIMIT)
  const decisions = getRecentWatchdogDecisions({ project: d.project, runId: d.runId, limit })

  try {
    ctx.ws.send(JSON.stringify({ type: 'nightshift_watchdog_result', requestId: d.requestId, ok: true, decisions }))
  } catch {
    /* socket gone -- caller navigated away */
  }
}

export function registerNightshiftWatchdogHandlers(): void {
  registerHandlers({ nightshift_watchdog_request: watchdogRequest }, CONTROL_PANEL_ONLY)
}

/**
 * Card ledger relay -- THE WALL's P3 feed.
 *
 * Two directions, two trust levels:
 *
 *   sentinel -> `card_changed`        recorded in the ring, then rebroadcast
 *                                     permission-gated by the move's project
 *   panel    -> `card_ledger_request` reads the ring back, filtered to the
 *                                     projects that caller may actually read
 *
 * The ring is GLOBAL (every project the broker's sentinels watch) while a
 * viewer's grants are per-project, so the read path filters -- an unfiltered
 * ring would hand a scoped guest the card titles of every board on the box.
 *
 * Separate from `handlers/project.ts` on purpose: that module relays board CRUD
 * and file reads for the panel; this one is a history feed with its own storage
 * and its own disclosure rule.
 */

import type { CardChanged } from '../../shared/protocol'
import { readCardLedger, recordCardMoves } from '../card-ledger-ring'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers, SENTINEL_ONLY } from '../message-router'

/**
 * `chat:read`, NOT `files:read`, on purpose: the push side is `broadcastScoped`,
 * which is hard-wired to `chat:read`. Gating the pull side any differently gives
 * some viewer live moves and an empty cold seed (or the reverse) -- one feed,
 * one gate. The disclosure is also strictly smaller than what already flows on
 * that gate: `project_changed` carries every card's title and body preview.
 *
 * `requirePermission` throws rather than returning a verdict, and the read path
 * needs a verdict per project. Reusing the guard keeps ONE policy -- a second
 * hand-rolled `resolvePermissions` call is how the two drift apart.
 */
function canRead(ctx: HandlerContext, project: string): boolean {
  try {
    ctx.requirePermission('chat:read', project)
    return true
  } catch {
    return false
  }
}

// Sentinel -> broker: cards crossed lanes. Record, log, fan out.
const cardChanged: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const d = data as unknown as CardChanged
  const project = typeof d.project === 'string' ? d.project : ''
  const moves = Array.isArray(d.moves) ? d.moves : []
  if (!project || moves.length === 0) {
    ctx.log.debug(`[card-ledger] dropping card_changed: project=${project || '<none>'} moves=${moves.length}`)
    return
  }
  recordCardMoves(moves)
  for (const m of moves) ctx.log.info(`[card-ledger] ${m.id}: ${m.from} -> ${m.to} (source=sentinel, ${project})`)
  ctx.broadcastScoped({ type: 'card_changed', project, moves }, project)
}

// Panel -> broker: seed a cold surface from the ring.
const cardLedgerRequest: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? Math.floor(data.limit) : undefined
  const moves = readCardLedger({ limit, allow: project => canRead(ctx, project) })
  ctx.log.debug(`[card-ledger] ledger read: ${moves.length} move(s) (limit=${limit ?? 'default'})`)
  ctx.reply({ type: 'card_ledger_result', requestId: data.requestId, ok: true, moves })
}

export function registerCardLedgerHandlers(): void {
  registerHandlers({ card_ledger_request: cardLedgerRequest }, CONTROL_PANEL_ONLY)
  registerHandlers({ card_changed: cardChanged }, SENTINEL_ONLY)
}

export const __testing = { cardChanged, cardLedgerRequest }

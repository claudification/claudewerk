/**
 * Card ledger INGEST -- THE WALL's P3 feed, sentinel side only.
 *
 * One direction: `card_changed` arrives from a sentinel, lands in the global
 * ring, and is handed to the wall channel. Nothing leaves this module for a
 * panel. The wall's own frame carries the ledger both cold (the `full: true`
 * snapshot seeds from `readCardLedger()` in `wall/wall-sources.ts`) and live
 * (the deltas `publishWallCardMoves` feeds), and that channel does its own
 * per-subscriber permission filtering on flush.
 *
 * That is why there is no read verb and no `broadcastScoped` here any more:
 * both were replaced by the one wall channel, and a second path to the same
 * rows is a second disclosure rule to keep in sync. The ring is GLOBAL (every
 * project the broker's sentinels watch) while a viewer's grants are
 * per-project, so whoever reads it owes that filter -- today that is exactly
 * one caller, the wall.
 *
 * Separate from `handlers/project.ts` on purpose: that module relays board CRUD
 * and file reads for the panel; this one only records history.
 */

import type { CardChanged } from '../../shared/protocol'
import { recordCardMoves } from '../card-ledger-ring'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { registerHandlers, SENTINEL_ONLY } from '../message-router'
import { publishWallCardMoves } from '../wall'

// Sentinel -> broker: cards crossed lanes. Record, log, hand to the wall.
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
  // THE WALL takes the same moves through its one channel, coalesced at ~2 Hz
  // and filtered per subscriber on flush. No-op while no wall is open.
  publishWallCardMoves(moves)
}

export function registerCardLedgerHandlers(): void {
  registerHandlers({ card_changed: cardChanged }, SENTINEL_ONLY)
}

export const __testing = { cardChanged }

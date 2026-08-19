/**
 * Permission receipts -- the durable half of a tool-permission gate.
 *
 * A gate used to be entirely ephemeral: a banner appeared, the human clicked,
 * the banner vanished, and nothing anywhere recorded that a tool had been gated,
 * who allowed it, or how long it blocked. Reload and the evidence was gone.
 *
 * Now both halves are transcript entries. Two entries, not one mutated row:
 * the transcript store is INSERT-OR-IGNORE by uuid (add-transcript-entries.ts),
 * so re-sending the request's uuid with a resolved outcome would be silently
 * DROPPED. The control panel folds the pair by `requestId` into one card.
 *
 * `decidedBy` is stamped from the SOCKET, never from the payload -- a client
 * must not be able to sign someone else's name to an allow.
 */

import { randomUUID } from 'node:crypto'
import type {
  PermissionOutcome,
  TranscriptPermissionDecisionEntry,
  TranscriptPermissionRequestEntry,
} from '../../shared/protocol'
import type { TranscriptIngestTarget } from '../transcript-ingest'
import { ingestAndBroadcast } from '../transcript-ingest'

export interface PermissionRequestFacts {
  requestId: string
  toolUseId?: string
  toolName: string
  description?: string
  inputPreview?: string
}

export interface PermissionDecisionFacts {
  requestId: string
  toolUseId?: string
  toolName: string
  outcome: PermissionOutcome
  /** Identity that answered. Omit for `auto` / `expired` -- no human decided. */
  decidedBy?: string
  /** Milliseconds the gate blocked, request -> decision. */
  waitedMs?: number
  ruleCreated?: boolean
}

/** Stamp the ASK into the transcript, at the point in the conversation where
 *  CC actually asked. */
export function emitPermissionRequestEntry(
  store: TranscriptIngestTarget,
  conversationId: string,
  facts: PermissionRequestFacts,
): void {
  const entry: TranscriptPermissionRequestEntry = {
    type: 'permission_request',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    conversationId,
    ...facts,
  }
  ingestAndBroadcast(store, conversationId, [entry])
}

/** Stamp the ANSWER: outcome, who, and how long it blocked. */
export function emitPermissionDecisionEntry(
  store: TranscriptIngestTarget,
  conversationId: string,
  facts: PermissionDecisionFacts,
): void {
  const entry: TranscriptPermissionDecisionEntry = {
    type: 'permission_decision',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    decidedAt: Date.now(),
    conversationId,
    ...facts,
  }
  ingestAndBroadcast(store, conversationId, [entry])
}

/** Which outcome a human answer produced. ALWAYS (`rule`) is its own outcome so
 *  the receipt says a standing rule was installed, not merely that one call was
 *  allowed. */
export function outcomeForAnswer(behavior: unknown, rule: boolean): PermissionOutcome {
  if (behavior !== 'allow') return 'denied'
  return rule ? 'allowed_always' : 'allowed'
}

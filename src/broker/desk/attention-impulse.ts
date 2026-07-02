/**
 * PROACTIVE IMPULSES (N2) -- the fleet wakes the dispatcher. Until now the
 * dispatcher only ever ran on a user turn or a quest report-back; nothing in
 * the fleet (a conversation flipping needs_you, a CONTENDED collision, a git
 * escalation) could reach the brain. This module connects SENSE to DECIDE.
 *
 * Mechanic = the living-history core mandate: fold the signal into the
 * `<attention>` block (a rolling, capped list -- the mutation IS the impulse,
 * same as `<findings>`), then run ONE dispatcher turn that decides push /
 * note / hold. The attention-policy layer (cooldowns + dedupe + a global
 * turn cap) keeps this a sentinel, not a nuisance. Signals over the turn cap
 * still land in the block -- awareness is never rate-limited, only spend.
 *
 * No new machinery: composes onDeskEvent (live_status) + onContribution
 * (git_scan / callout) + getUserHistory/upsertBlock + runDispatchAgent +
 * broadcastToSubscribers, exactly like async-impulse.ts.
 */

import type { DispatchDecision, DispatchImpulseMessage } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { broadcastToSubscribers } from '../routes/shared'
import { type ContributionEvent, onContribution } from '../sotu/contribute'
import { readLiveQueue } from '../sotu/queue'
import { deriveAlerts, deriveHolds } from '../sotu/view'
import { runDispatchAgent } from './agent-runtime'
import { type AttentionPolicy, type AttentionSignal, createAttentionPolicy, describeSignal } from './attention-policy'
import { type DeskEvent, onDeskEvent } from './event-registry'
import { getUserHistory, listHistoryUsers, markDirty } from './history-store'
import { getBlock, upsertBlock } from './living-history'
import type { DispatchRuntime } from './runtime'

export const ATTENTION_BLOCK_ID = 'attention'
const MAX_ATTENTION_LINES = 5

/** Injectable seams (tests). Defaults are the live loop + WS broadcast. */
export interface AttentionDeps {
  runImpulse?: (
    intent: string,
    rt: DispatchRuntime,
    opts: { userId: string | null; recordUserTurn?: boolean },
  ) => Promise<DispatchDecision>
  broadcast?: (store: ConversationStore, message: Record<string, unknown>) => void
  listUsers?: () => Array<string | null>
  policy?: AttentionPolicy
  log?: (msg: string) => void
}

/** Fold a line into the rolling `<attention>` block (newest last, capped). */
export function appendAttentionLine(userId: string | null, line: string, ts: number): void {
  const h = getUserHistory(userId)
  const existing = getBlock(h, ATTENTION_BLOCK_ID)?.content ?? ''
  const lines = existing.split('\n').filter(Boolean)
  lines.push(`- ${line}`)
  upsertBlock(h, ATTENTION_BLOCK_ID, 'attention', lines.slice(-MAX_ATTENTION_LINES).join('\n'), ts)
}

function impulseTrigger(description: string): string {
  return (
    `ATTENTION -- ${description}. The <attention> block lists recent fleet signals. ` +
    'Decide what this one deserves: if the user should know NOW, call notify_user with one short line; ' +
    'if it needs a control action you can take it; otherwise just acknowledge in one short line. ' +
    'Do NOT dispatch quests or wake conversations for this unless the user has a standing request.'
  )
}

/** Deliver one signal to every dispatcher user: block fold always; an LLM turn
 *  only when the policy's global cap allows. LOG EVERYTHING on the way. */
export async function deliverAttentionImpulse(
  store: ConversationStore,
  sig: AttentionSignal,
  policy: AttentionPolicy,
  deps: AttentionDeps = {},
): Promise<void> {
  const runImpulse = deps.runImpulse ?? runDispatchAgent
  const broadcast = deps.broadcast ?? broadcastToSubscribers
  const listUsers = deps.listUsers ?? listHistoryUsers
  const log = deps.log ?? (m => console.log(m))
  const now = Date.now()
  const description = describeSignal(sig)

  for (const userId of listUsers()) {
    appendAttentionLine(userId, description, now)
    markDirty(userId)
    const impulse: DispatchImpulseMessage = {
      type: 'dispatch_impulse',
      userId,
      source: sig.kind,
      description,
      ts: now,
    }
    if (sig.kind === 'needs_you') impulse.conversationId = sig.conversationId
    if ('project' in sig && sig.project) impulse.project = sig.project
    broadcast(store, impulse as unknown as Record<string, unknown>)

    if (!policy.allowTurn(now)) {
      log(`[attention] ${sig.kind} for ${userId ?? 'anon'} folded WITHOUT a turn (rate cap): ${description}`)
      continue
    }
    log(`[attention] ${sig.kind} -> impulse turn for ${userId ?? 'anon'}: ${description}`)
    const rt: DispatchRuntime = { store, callerConversationId: null }
    const decision = await runImpulse(impulseTrigger(description), rt, { userId, recordUserTurn: false })
    broadcast(store, { ...decision, userId })
  }
}

let stop: (() => void) | null = null

/** Signals from one contribution: git escalations + newly-contended targets. */
function contributionSignals(ev: ContributionEvent, policy: AttentionPolicy, now: number): AttentionSignal[] {
  if (!ev.project) return []
  if (ev.contrib.kind === 'git_scan') {
    return policy.observeGitAlerts(ev.project, deriveAlerts(ev.contrib.git), now)
  }
  if (ev.contrib.kind === 'callout' && ev.contrib.target) {
    const contended = deriveHolds(readLiveQueue(ev.slug, now))
      .filter(h => h.contended)
      .map(h => ({ target: h.target, holders: h.holders.length }))
    return policy.observeContended(ev.project, contended, now)
  }
  return []
}

/** Wire the sentinel: live_status flips + SOTU contributions -> impulses.
 *  Handlers only enqueue (fire-and-forget delivery) -- the buses require cheap,
 *  non-blocking subscribers. Idempotent stop via stopAttentionImpulses(). */
export function startAttentionImpulses(store: ConversationStore, deps: AttentionDeps = {}): void {
  const policy = deps.policy ?? createAttentionPolicy()
  const log = deps.log ?? (m => console.log(m))
  const deliver = (sig: AttentionSignal) =>
    void deliverAttentionImpulse(store, sig, policy, deps).catch(err =>
      log(`[attention] delivery failed for ${sig.kind}: ${(err as Error)?.message ?? err}`),
    )

  const offDesk = onDeskEvent((e: DeskEvent) => {
    if (e.kind !== 'live_status') return
    const sig = policy.observeStatus(e.conversationId, e.project, e.state, e.ts)
    if (sig) deliver(sig)
  })
  const offContrib = onContribution(ev => {
    for (const sig of contributionSignals(ev, policy, Date.now())) deliver(sig)
  })
  stop = () => {
    offDesk()
    offContrib()
  }
  log('[attention] proactive impulses armed (needs_you/blocked flips, git escalations, contention)')
}

export function stopAttentionImpulses(): void {
  stop?.()
  stop = null
}

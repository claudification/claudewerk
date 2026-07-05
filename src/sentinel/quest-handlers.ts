/**
 * Sentinel handlers for the QUEST substrate RPCs (plan-quest-engine §4/§13).
 * The dispatch in index.ts resolves `projectRoot` (expandPath against spawnRoot)
 * and calls `handleQuestOp` with the absolute root; every path op is jailed
 * under it by src/shared/quest-store.ts.
 *
 * One op-envelope in (QuestOp), one result out (QuestResult) -- mirrors
 * nightshift-handlers.ts. The sentinel is the SOLE writer of the quest tree, so
 * quest state works with zero live agent hosts (§14 recoverability). Op dispatch
 * is a strategy map (STRATEGY MAPS covenant), not a switch.
 */

import type { QuestOp, QuestOpKind, QuestResult } from '../shared/protocol'
import { computeQuestStatus, stampAbortCards, tagQuestCards } from '../shared/quest-cards'
import { appendLogEntry, createQuest, getQuest, listQuests, patchManifest, readManifest } from '../shared/quest-store'

/** The op-specific fields of a QuestResult (everything but the envelope header). */
type OpOutcome = Omit<QuestResult, 'type' | 'requestId' | 'op'>
type QuestOpHandler = (root: string, msg: QuestOp, nowMs: number) => OpOutcome

const fail = (error: string): OpOutcome => ({ ok: false, error })

const HANDLERS: Record<QuestOpKind, QuestOpHandler> = {
  // fallow-ignore-next-line complexity
  create(root, msg, nowMs) {
    if (!msg.create?.goal) return fail('create.goal required')
    const manifest = createQuest(
      root,
      {
        project: msg.projectRoot,
        goal: msg.create.goal,
        target: msg.create.target,
        gate: msg.create.gate,
        status: msg.create.status,
        contracts: msg.create.contracts,
        petname: msg.create.petname,
      },
      nowMs,
    )
    const taggedCards = msg.create.cards?.length ? tagQuestCards(root, manifest.petname, msg.create.cards) : []
    return { ok: true, manifest, taggedCards }
  },

  update(root, msg, nowMs) {
    if (!msg.petname) return fail('petname required for update')
    if (!msg.patch) return fail('patch required for update')
    const manifest = patchManifest(root, msg.petname, msg.patch, nowMs)
    return manifest ? { ok: true, manifest } : fail(`quest not found: ${msg.petname}`)
  },

  log_append(root, msg, nowMs) {
    if (!msg.petname) return fail('petname required for log_append')
    if (!msg.logAppend?.body) return fail('logAppend.body required')
    return { ok: true, logEntry: appendLogEntry(root, msg.petname, msg.logAppend, nowMs) }
  },

  get(root, msg) {
    if (!msg.petname) return fail('petname required for get')
    return { ok: true, detail: getQuest(root, msg.petname) }
  },

  list(root) {
    return { ok: true, quests: listQuests(root) }
  },

  status(root, msg) {
    if (!msg.petname) return fail('petname required for status')
    const manifest = readManifest(root, msg.petname)
    return manifest ? { ok: true, report: computeQuestStatus(root, manifest) } : fail(`quest not found: ${msg.petname}`)
  },

  abort(root, msg, nowMs) {
    if (!msg.petname) return fail('petname required for abort')
    const reason = msg.reason || 'aborted by quest giver'
    const manifest = patchManifest(root, msg.petname, { status: 'aborted', abortReason: reason }, nowMs)
    if (!manifest) return fail(`quest not found: ${msg.petname}`)
    return { ok: true, manifest, abortedCards: stampAbortCards(root, msg.petname, reason, nowMs) }
  },

  pause(root, msg, nowMs) {
    if (!msg.petname) return fail('petname required for pause')
    const manifest = patchManifest(root, msg.petname, { status: 'paused' }, nowMs)
    return manifest ? { ok: true, manifest } : fail(`quest not found: ${msg.petname}`)
  },
}

export function handleQuestOp(root: string, msg: QuestOp, nowMs: number): QuestResult {
  const base = { type: 'quest_result' as const, requestId: msg.requestId, op: msg.op }
  const handler = HANDLERS[msg.op]
  if (!handler) return { ...base, ok: false, error: `unknown op: ${msg.op}` }
  try {
    return { ...base, ...handler(root, msg, nowMs) }
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message }
  }
}

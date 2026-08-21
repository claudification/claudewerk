/**
 * The BROKER-SIDE epic actions -- `inspect`, `list`, `beat`, `break_lease`,
 * `delete`.
 *
 * Four of the five are assembled from things the broker already holds (its
 * conversation registry, the armed set, the beat ring) plus reads it already
 * makes, and add no sentinel op at all. `delete` is the one that does, and it
 * belongs on this side for the same reason `break_lease` does: the refusal that
 * matters most is a question only the broker can answer -- is the lease holder
 * still alive, is a seat still writing to the tree this verb is about to move.
 *
 * Split out of `epic.ts` so that file stays parse -> gate -> dispatch, and the
 * behaviour worth testing sits somewhere a test can call it.
 */

import { buildEpicIndex } from '../../shared/epic-cards'
import type { EpicLogEntry } from '../../shared/epic-run-types'
import type { EpicBatonQuery, EpicInspectResult, EpicRunListEntry } from '../../shared/protocol'
import { appendBaton, fetchBoardCards, fetchEpicRun, sendEpicOp } from '../epic-broker-rpc'
import { inspectEpic, listEpicRuns } from '../epic-inspect'
import { epicConversations } from '../epic-inspect-view'
import { forgetArmedEpic, noteDeletedEpic } from '../epic-registry'
import { beatOneEpic, type SweepDeps } from '../epic-sweep-loop'

/**
 * Effects, swappable -- the same seam and the same reason as `EpicIo`: Bun's
 * `mock.module` is PROCESS-WIDE and leaks doubles into every test file that runs
 * after it, so a stub taken here would silently rewrite the RPC layer for
 * unrelated suites.
 */
export interface ActionIo {
  fetchEpicRun: typeof fetchEpicRun
  fetchBoardCards: typeof fetchBoardCards
  sendEpicOp: typeof sendEpicOp
  appendBaton: typeof appendBaton
  inspectEpic: typeof inspectEpic
  listEpicRuns: typeof listEpicRuns
  beatOneEpic: typeof beatOneEpic
}

const REAL_IO: ActionIo = {
  fetchEpicRun,
  fetchBoardCards,
  sendEpicOp,
  appendBaton,
  inspectEpic,
  listEpicRuns,
  beatOneEpic,
}
let io: ActionIo = REAL_IO

/** CUMULATIVE, like `configureEpicIo` -- layers on what is configured now, so a
 *  second call cannot silently un-stub what the first replaced. */
export function configureActionIo(next: Partial<ActionIo>): void {
  io = { ...io, ...next }
}
export function resetActionIo(): void {
  io = REAL_IO
}

export interface ActionInput {
  project: string
  epicId: string
  reason?: string
  force?: boolean
  beats?: number
  baton?: EpicBatonQuery
}

export type ActionResult =
  | { ok: true; inspect: EpicInspectResult }
  | { ok: true; runs: EpicRunListEntry[] }
  | { ok: true; beat: { note: string; actions: number; spawned: string[]; error?: string } }
  | { ok: true; note: string; baton?: EpicLogEntry }
  | { ok: false; error: string; status: 409 | 502 }

async function actionInspect(deps: SweepDeps, input: ActionInput): Promise<ActionResult> {
  return {
    ok: true,
    inspect: await io.inspectEpic(deps, input.project, input.epicId, {
      ...(input.beats ? { beats: input.beats } : {}),
      ...(input.baton ? { baton: input.baton } : {}),
    }),
  }
}

async function actionList(deps: SweepDeps, input: ActionInput): Promise<ActionResult> {
  return { ok: true, runs: await io.listEpicRuns(deps, input.project) }
}

/**
 * Force one beat now.
 *
 * Grants no capability that `start` did not already grant -- an armed run beats
 * every 45s regardless, so this only changes WHEN, never WHETHER. That is why it
 * sits behind the same `files` permission and not something stricter.
 *
 * A refusal here is normal and not an error worth alarming about: it means the
 * scheduled sweep is mid-tick, which is precisely when a second beat would race
 * it into overshooting the concurrency ceiling.
 */
export async function actionBeat(deps: SweepDeps, input: ActionInput): Promise<ActionResult> {
  const res = await io.beatOneEpic(deps, input.project, input.epicId)
  if (!res.ok) return { ok: false, error: res.error, status: 409 }
  const { note, actions, spawned, error } = res.outcome
  return { ok: true, beat: { note, actions, spawned, ...(error ? { error } : {}) } }
}

/**
 * Break a stuck overseer lease.
 *
 * `docs/epic-mode.md` promises the lease is visible and breakable by a human
 * because it lives on the card -- but the only way to break it was to hand-edit
 * frontmatter, and the ops that touch it are engine-internal over HTTP. This is
 * that promise, as a verb.
 *
 * It RELEASES rather than force-granting. A caller breaking a lease wants the
 * epic unstuck, not to become its overseer, and `evaluateLease`'s `force` path
 * would hand them the seat. Releasing leaves the generation counter intact and
 * lets the next beat wake a real overseer through the normal CAS.
 */
export async function actionBreakLease(deps: SweepDeps, input: ActionInput): Promise<ActionResult> {
  const view = await io.fetchEpicRun(deps, input.project, input.epicId, { limit: 1 })
  if (view.error) return { ok: false, error: view.error, status: 502 }

  const holder = view.lease
  if (!holder?.convId) return { ok: true, note: 'no lease is held; nothing to break' }

  // A LIVE holder is a working overseer, not a stuck one. Refusing by default
  // is the difference between an unstick tool and a way to shoot a run in the
  // head mid-generation.
  const conv = deps.getAllConversations().find(c => c.id === holder.convId)
  if (conv && deps.isLive(conv) && !input.force) {
    return {
      ok: false,
      error: `overseer ${holder.convId} is still live at gen ${holder.gen} (since ${holder.at}). Pass force to break it anyway.`,
      status: 409,
    }
  }

  const released = await io.sendEpicOp(deps, input.project, { op: 'release', epicId: input.epicId })
  if (!released.ok) return { ok: false, error: released.error ?? 'release failed', status: 502 }

  const why = input.reason || 'no reason given'
  const logged = await io.appendBaton(deps, input.project, input.epicId, {
    kind: 'steering',
    convId: 'broker',
    body: `Overseer lease BROKEN by hand at gen ${holder.gen} (holder \`${holder.convId}\`, taken ${holder.at}): ${why}`,
  })
  return {
    ok: true,
    note: `released the lease held by ${holder.convId} at gen ${holder.gen}. The next beat will wake a fresh overseer.`,
    ...(logged.logEntry ? { baton: logged.logEntry } : {}),
  }
}

/**
 * WHAT A DELETE LEAVES BEHIND, said before anyone can be surprised by it.
 *
 * Deleting a run does NOT delete its cards, and that is deliberate: cards
 * outlive runs by design -- it is what let `epic-project-runner` adopt eight
 * cards that already existed -- so a run is the record of an ATTEMPT and the
 * cards are the work. A human deleting a run will assume the opposite unless
 * told, so the reply says it in words rather than leaving it to be discovered.
 */
async function orphanNote(deps: SweepDeps, project: string, epicId: string): Promise<string> {
  const rollup = buildEpicIndex(await io.fetchBoardCards(deps, project)).get(epicId)
  const open = rollup ? rollup.notStarted + rollup.inProgress : 0
  if (!rollup) return 'Its cards were NOT touched -- deleting a run never deletes cards.'
  return (
    `Its ${rollup.children.length} card(s) were NOT touched -- ${open} of them unfinished. ` +
    'Deleting a run never deletes cards; arm the epic again to keep working them.'
  )
}

/**
 * DELETE A RUN -- remove it from the record, recoverably.
 *
 * A BROKER ACTION and not a bare sentinel op, for the same reason `break_lease`
 * is one: the refusal that matters most here is a question only the broker can
 * answer. The sentinel refuses on the run's own status (armed / running), which
 * it can read off the artifact; it cannot know whether a conversation carrying
 * this epic's tag is still alive, and that is the seat that would be writing
 * into a tree this verb is about to move out from under it.
 *
 * STRICTER THAN `clear` ON PURPOSE. `clear` tolerates dead seats because an
 * acknowledgement it gets wrong is one click from being undone. This one refuses
 * on ANY live seat.
 *
 * NOT STRICTER ABOUT CARDS. An open card is reported, never a refusal: a run
 * armed by mistake on an epic with twenty open cards is precisely the case this
 * verb exists for, and refusing there would make it useless exactly when it is
 * wanted. See `orphanNote`.
 */
export async function actionDelete(deps: SweepDeps, input: ActionInput): Promise<ActionResult> {
  const view = await io.fetchEpicRun(deps, input.project, input.epicId, { limit: 1 })
  if (view.error) return { ok: false, error: view.error, status: 502 }
  if (!view.run) {
    return { ok: false, error: `${input.epicId} has no run artifact -- there is nothing to delete`, status: 409 }
  }

  const live = epicConversations(deps.getAllConversations(), deps.isLive, input.epicId).filter(c => c.live)
  if (live.length > 0) {
    return {
      ok: false,
      error:
        `${live.length} conversation(s) tagged with ${input.epicId} are still live ` +
        `(${live.map(c => c.id).join(', ')}) -- stop them before deleting the run they are writing to`,
      status: 409,
    }
  }

  const cards = await orphanNote(deps, input.project, input.epicId)
  const res = await io.sendEpicOp(deps, input.project, {
    op: 'delete',
    epicId: input.epicId,
    ...(input.reason ? { reason: input.reason } : {}),
  })
  if (!res.ok) return { ok: false, error: res.error ?? 'delete failed', status: 409 }

  // AFTER the sentinel confirms, never before. A run left in the armed set is a
  // run the sweep keeps looking for, and a tombstone written for a delete the
  // sentinel refused would hide a run that is still very much there.
  forgetArmedEpic(input.project, input.epicId)
  noteDeletedEpic(input.project, input.epicId)
  // Same moment `start` / `pause` / `abort` publish: a human who just deleted a
  // run is definitely looking at the badge, and waiting 45s for the next tick to
  // agree with the click would read as the delete not having worked.
  void deps.publishActivity?.()

  const where = res.deletedTo ? ` The artifact was MOVED to \`${res.deletedTo}\`, not destroyed.` : ''
  return { ok: true, note: `deleted the ${input.epicId} run (was ${view.run.status}).${where} ${cards}` }
}

/**
 * Which broker actions exist, and what they do. A strategy map so `epic.ts` can
 * ask "is this a broker action" and "run it" without knowing any of them.
 */
export const BROKER_ACTIONS: Record<string, (deps: SweepDeps, input: ActionInput) => Promise<ActionResult>> = {
  inspect: actionInspect,
  list: actionList,
  beat: actionBeat,
  break_lease: actionBreakLease,
  delete: actionDelete,
}

/**
 * Broker actions that change something. Drives the permission choice.
 *
 * `break_lease` deliberately does NOT un-arm the run: breaking a lease is an
 * unstick, not a stop, and the whole point is that the next beat wakes a fresh
 * overseer. Only `pause`, `abort` and `delete` drop a run out of the sweep.
 */
export const BROKER_WRITE_ACTIONS = new Set(['beat', 'break_lease', 'delete'])

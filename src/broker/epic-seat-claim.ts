/**
 * THE SEAT CLAIM, orchestrated -- the broker half of the per-card mutex.
 *
 * The seat calls one tool with no arguments. Everything the claim needs is read
 * HERE, from the conversation registry, and that is the whole security model:
 *
 *   - WHICH card and role -- from the caller's own `EpicLaunchTag`, never from
 *     an argument. A tool that accepted an arbitrary `cardId` from any session
 *     would be a way to evict a live worker from its own card.
 *   - WHO holds the seat -- from `seat_get`.
 *   - WHETHER that holder is alive -- from the registry. The sentinel cannot
 *     know this and must not guess (same split as the overseer lease).
 *
 * THE ORDER OF THE THREE GATES MATTERS. A caller with no epic tag is refused
 * WITHOUT being told to exit: this is a mutex between seats, not a way to kill
 * any conversation that calls the wrong tool. `exit` is set on exactly one
 * outcome -- a genuine same-`(card, role)` collision.
 *
 * AND A TRANSPORT FAILURE IS NOT A REFUSAL. If the sentinel is down or the op
 * times out, the answer is an error the seat is told to IGNORE. A seat that
 * cannot reach the broker must still be able to work; the dispatch guard above
 * is the protection for that beat. A lease that becomes a precondition for
 * working is a new way for the whole engine to stop.
 */

import type { EpicLease } from '../shared/epic-lease'
import type { EpicRole } from '../shared/epic-run-types'
import { type SeatLeaseKey, seatClaimBaton, seatRefusalNotice, seatSlug } from '../shared/epic-seat-lease'
import type { Conversation } from '../shared/protocol'
import type { SentinelRpcDeps } from './broker-sentinel-rpc'
import { appendBaton, sendEpicOp } from './epic-broker-rpc'

export interface SeatClaimDeps extends SentinelRpcDeps {
  getAllConversations: () => Conversation[]
  isLive: (conv: Conversation) => boolean
  /**
   * May this caller act on this project? Asked AFTER the seat resolves, because
   * the project comes from the CALLER'S OWN conversation and never from the
   * request -- there is no project in the request to gate on before that.
   *
   * ABSENT MEANS NO GATE, matching `SweepDeps.scannerOptIn`: every test that
   * builds deps by hand means "no gate", and the route always installs the real
   * one.
   */
  authorize?: (project: string) => boolean
}

/**
 * Effects, injected rather than module-global. Bun's `mock.module` is
 * PROCESS-WIDE and leaks doubles into every test file that runs after it, so a
 * stub taken at module scope would silently rewrite the RPC layer for unrelated
 * suites -- the same reason `ActionIo` and `EpicIo` exist.
 */
export interface SeatClaimIo {
  sendEpicOp: typeof sendEpicOp
  appendBaton: typeof appendBaton
}

const REAL_IO: SeatClaimIo = { sendEpicOp, appendBaton }

export interface SeatClaimInput {
  /** The calling conversation, taken from the agent host's own identity. */
  convId: string
  action: 'claim' | 'release'
  /**
   * AN ASSERTION, NEVER A SELECTOR. When present it must equal the card the
   * caller was dispatched onto; a mismatch is refused. It exists so a seat that
   * has confused itself about which card it holds finds out here rather than by
   * writing into somebody else's worktree.
   */
  cardId?: string
}

export type SeatClaimOutcomeKind = 'granted' | 'broke' | 'held' | 'released' | 'refused' | 'error'

export interface SeatClaimReply {
  ok: boolean
  outcome: SeatClaimOutcomeKind
  /** What the caller is told, verbatim. */
  note: string
  /** THE ONE FLAG THAT KILLS A SEAT. Set only on `refused`. */
  exit?: true
  seat?: SeatLeaseKey
  lease?: EpicLease
  status?: 400 | 403 | 409 | 502
}

const errorReply = (note: string, status: 400 | 403 | 502): SeatClaimReply => ({
  ok: false,
  outcome: 'error',
  note,
  status,
})

/** The caller, resolved to a seat -- or the refusal that says why it is not one. */
function resolveSeat(
  deps: SeatClaimDeps,
  input: SeatClaimInput,
): { conv: Conversation; project: string; key: SeatLeaseKey } | SeatClaimReply {
  const conv = deps.getAllConversations().find(c => c.id === input.convId)
  if (!conv) return errorReply(`no conversation ${input.convId} in the registry`, 403)

  const tag = conv.launchConfig?.epic
  if (!tag?.epicId) {
    return errorReply(
      'the seat lease is for WERK-launched seats only -- this conversation carries no epic launch tag',
      403,
    )
  }
  if (!tag.cardId) {
    return errorReply(
      `this is the ${tag.role} seat for epic \`${tag.epicId}\` and holds no card. The overseer's singleton is the ` +
        'epic lease, taken by the engine; there is no card seat to claim.',
      403,
    )
  }
  if (input.cardId && input.cardId !== tag.cardId) {
    return errorReply(
      `you were dispatched onto \`${tag.cardId}\`, not \`${input.cardId}\` -- a seat may only claim its own card`,
      403,
    )
  }
  if (!conv.project) return errorReply(`conversation ${input.convId} has no project to resolve`, 400)
  if (deps.authorize && !deps.authorize(conv.project)) {
    return errorReply(`Forbidden: files permission required for ${conv.project}`, 403)
  }

  return { conv, project: conv.project, key: { epicId: tag.epicId, cardId: tag.cardId, role: tag.role as EpicRole } }
}

/**
 * Is the holder still working? The registry's answer, never the claimant's.
 *
 * A holder the registry has never heard of is NOT alive: an id no lookup can
 * resolve is exactly the `pending-` placeholder failure the overseer lease hit
 * on 2026-08-19, and treating it as alive would make the seat permanently
 * unclaimable.
 */
function holderIsAlive(deps: SeatClaimDeps, holder: EpicLease | null): boolean {
  if (!holder?.convId) return false
  const conv = deps.getAllConversations().find(c => c.id === holder.convId)
  return Boolean(conv && deps.isLive(conv))
}

/**
 * The baton line for a collision. WRITTEN ON REFUSAL AND ON TAKEOVER, silent on
 * an uncontested grant.
 *
 * A line per successful connect would be one entry per dispatched seat, and the
 * baton tail an overseer generation is handed is twenty entries -- so the
 * routine case would push the interesting case out of every prompt. Both cases
 * written here are the interesting one: two seats existed for one card.
 *
 * `dispatch-failed` because that is precisely what happened -- a dispatched seat
 * produced nothing and stopped. It acknowledges no card and is not counted
 * against the redispatch ceiling (epic-log.ts), so recording the collision
 * cannot itself strand the card.
 */
async function auditCollision(
  deps: SeatClaimDeps,
  io: SeatClaimIo,
  project: string,
  key: SeatLeaseKey,
  body: string,
  convId: string,
): Promise<void> {
  await io.appendBaton(deps, project, key.epicId, { kind: 'dispatch-failed', convId, cardId: key.cardId, body })
}

async function runRelease(
  deps: SeatClaimDeps,
  io: SeatClaimIo,
  project: string,
  key: SeatLeaseKey,
  convId: string,
): Promise<SeatClaimReply> {
  const res = await io.sendEpicOp(deps, project, {
    op: 'seat_release',
    epicId: key.epicId,
    seat: { cardId: key.cardId, role: key.role, convId },
  })
  if (!res.ok) return errorReply(`seat release failed: ${res.error ?? 'unknown error'}`, 502)
  return { ok: true, outcome: 'released', note: `Released the ${key.role} seat on \`${key.cardId}\`.`, seat: key }
}

async function runClaim(
  deps: SeatClaimDeps,
  io: SeatClaimIo,
  project: string,
  key: SeatLeaseKey,
  convId: string,
): Promise<SeatClaimReply> {
  const read = await io.sendEpicOp(deps, project, {
    op: 'seat_get',
    epicId: key.epicId,
    seat: { cardId: key.cardId, role: key.role },
  })
  if (!read.ok) return errorReply(`could not read the seat lease: ${read.error ?? 'unknown error'}`, 502)

  const holder = read.currentLease ?? null

  // ALREADY MINE. A seat that claims twice -- a retry, a resumed turn, a second
  // beat of its own prompt -- must not be told it lost to itself and killed by
  // its own belt. Answered before the CAS, because the CAS would refuse it.
  if (holder?.convId === convId) {
    return {
      ok: true,
      outcome: 'held',
      note: `You already hold the ${key.role} seat on \`${key.cardId}\`.`,
      seat: key,
      lease: holder,
    }
  }

  const res = await io.sendEpicOp(deps, project, {
    op: 'seat_claim',
    epicId: key.epicId,
    seat: {
      cardId: key.cardId,
      role: key.role,
      convId,
      expectGen: holder?.gen ?? 0,
      holderAlive: holderIsAlive(deps, holder),
    },
  })
  if (!res.ok || !res.lease) return errorReply(`seat claim failed: ${res.error ?? 'unknown error'}`, 502)

  if (!res.lease.granted) {
    const lost: EpicLease = { convId: res.lease.convId, gen: res.lease.gen, at: res.lease.at }
    const reason = res.lease.reason ?? 'the seat is held'
    await auditCollision(
      deps,
      io,
      project,
      key,
      seatClaimBaton({ key, convId, outcome: 'refused', holder: lost, reason }),
      convId,
    )
    return {
      ok: false,
      outcome: 'refused',
      exit: true,
      note: seatRefusalNotice(key, convId, lost, reason),
      seat: key,
      lease: lost,
      status: 409,
    }
  }

  const granted: EpicLease = { convId: res.lease.convId, gen: res.lease.gen, at: res.lease.at }
  const replaced = res.lease.replaced
  if (replaced?.convId) {
    await auditCollision(
      deps,
      io,
      project,
      key,
      seatClaimBaton({ key, convId, outcome: 'broke', holder: replaced }),
      convId,
    )
    return {
      ok: true,
      outcome: 'broke',
      note:
        `You hold the ${key.role} seat on \`${key.cardId}\` (generation ${granted.gen}). It was taken over from ` +
        `\`${replaced.convId}\`, which was dead or wedged past the stale window. That is recorded in the baton.`,
      seat: key,
      lease: granted,
    }
  }

  return {
    ok: true,
    outcome: 'granted',
    note: `You hold the ${key.role} seat on \`${key.cardId}\` (generation ${granted.gen}). Seat: ${seatSlug(key)}`,
    seat: key,
    lease: granted,
  }
}

/** One claim or release, end to end. Never throws: every failure is a reply. */
export async function claimSeat(
  deps: SeatClaimDeps,
  input: SeatClaimInput,
  io: SeatClaimIo = REAL_IO,
): Promise<SeatClaimReply> {
  const resolved = resolveSeat(deps, input)
  if ('outcome' in resolved) return resolved
  const { project, key } = resolved
  return input.action === 'release'
    ? runRelease(deps, io, project, key, input.convId)
    : runClaim(deps, io, project, key, input.convId)
}

/**
 * COMPOSING AN ORDER'S CAPS WITH THE SPAWN TRUST GATE.
 *
 * THE ONE RULE: an order may only ever NARROW the trust of whoever runs it.
 * Never widen. An order is a portable artifact -- today it is written by us and
 * lives in the repo, tomorrow (`werk-work-orders-share`) one arrives over a
 * link -- and the whole value of it evaporates the moment importing a role can
 * buy you a capability you did not already have.
 *
 * The gate is NOT re-implemented here. `evaluateSpawnPermission`
 * (spawn-permissions.ts) already owns "who may run at what trust", including
 * `bypassPermissions` being benevolent-only. This module builds the EFFECTIVE
 * request an order would produce and hands it to that same function, so the
 * refusal an order gets is byte-identical to the refusal a hand-written spawn
 * gets. A second copy of the ladder here is exactly how two ladders end up
 * disagreeing, and the more permissive one is the one that decides.
 *
 * THREE CLASSES OF FIELD, and the class decides how it composes:
 *
 *   PRIVILEGE  `permissionMode`, `maxBudgetUsd`, `maxTurns`
 *              -- narrow only. A mode goes through the trust gate; a budget and
 *              a turn ceiling are `min()` with the base, so an order asking for
 *              more gets less. The two ceilings compose identically because they
 *              are the same kind of promise about an unwatched seat: a hard stop
 *              nobody may raise by importing a role.
 *
 *   CAPABILITY `permissions.deny`
 *              -- add only. There is no `allow` on an order at all (order.ts),
 *              so this direction is the only one that exists.
 *
 *   SELECTION  `model`, `effort`, `agent`, `mcpConfigPath`
 *              -- no ladder to climb, so no narrowing to do. The EXPLICIT
 *              choice of whoever runs the order wins and the order supplies the
 *              default, matching `resolveSpawnConfig`'s existing
 *              explicit > profile > project > global precedence. An order that
 *              overrode an explicit choice would be a role quietly redirecting
 *              a human's spawn, which is the same class of surprise as widening.
 */

import type { Order, OrderCaps, OrderTrustLevel } from './order'
import { ORDER_TRUST_RANK } from './order'
import type { SpawnCallerContext, SpawnEvalResult, TrustLevel } from './spawn-permissions'
import { evaluateSpawnPermission } from './spawn-permissions'
import type { SpawnRequest } from './spawn-schema'

/** What the caller already decided, before the order gets a say. */
export interface OrderCapBase {
  model?: string
  effort?: OrderCaps['effort']
  agent?: string
  mcpConfigPath?: string
  maxBudgetUsd?: number
  maxTurns?: number
  permissionMode?: OrderCaps['permissionMode']
  /** Deny rules already in force (project config). The order's deny is unioned on. */
  deny?: string[]
}

/** The composed result -- exactly the fields a spawn plan then carries. */
export interface ComposedOrderCaps {
  model?: string
  effort?: OrderCaps['effort']
  agent?: string
  mcpConfigPath?: string
  maxBudgetUsd?: number
  maxTurns?: number
  permissionMode?: OrderCaps['permissionMode']
  deny?: string[]
}

export type OrderCapResult = { ok: true; caps: ComposedOrderCaps } | { ok: false; reason: string; field: string }

/** Present-wins-lowest. `undefined` on either side is "no opinion", not zero. */
function narrowest(base: number | undefined, order: number | undefined): number | undefined {
  if (base === undefined) return order
  if (order === undefined) return base
  return Math.min(base, order)
}

/**
 * THE PRIVILEGE LADDER for permission modes, least to most.
 *
 * Needed because the trust gate alone does not make the mode narrow-only: it
 * refuses `bypassPermissions` from a non-benevolent caller and nothing else, so
 * under benevolent trust an order could otherwise lift a `dontAsk` base all the
 * way to bypass simply by naming it. The ladder makes "an order may only ever
 * narrow" true for the mode as well, at every trust level.
 *
 *   plan            read-only planning
 *   dontAsk         allowlist-only, everything else denied
 *   acceptEdits     edits auto-accepted, the rest prompts
 *   auto            most tools auto-approved by the managed classifier
 *   bypassPermissions   no prompting at all
 */
const MODE_RANK: Record<NonNullable<OrderCaps['permissionMode']>, number> = {
  plan: 0,
  dontAsk: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
}

/** The less privileged of the two. An absent side has no opinion. */
function narrowestMode(
  base: OrderCaps['permissionMode'],
  order: OrderCaps['permissionMode'],
): OrderCaps['permissionMode'] {
  if (base === undefined) return order
  if (order === undefined) return base
  return MODE_RANK[order] < MODE_RANK[base] ? order : base
}

/**
 * WHO MAY DISPATCH THIS ORDER -- checked before anything else, and separately
 * from what the seat may do.
 *
 * The two used to be the same check by accident: every fleet order named
 * `bypassPermissions`, `evaluateSpawnPermission` refuses bypass below benevolent
 * trust, so the access control rode along on the privilege declaration. That
 * coupling meant NARROWING a seat -- `bypassPermissions` to `auto`, strictly
 * less power -- would also have removed the gate on who could start it, which is
 * the opposite of what narrowing is supposed to do. `Order.minTrust` says it out
 * loud so the two can move independently.
 *
 * Returns the refusal reason, or null when the caller clears the bar. An order
 * with no `minTrust` has no opinion and always clears -- the ordinary spawn gate
 * below is still there.
 */
function belowMinTrust(order: Order, caller: TrustLevel): string | null {
  const required = order.minTrust
  if (required === undefined) return null
  if (ORDER_TRUST_RANK[caller] >= ORDER_TRUST_RANK[required]) return null
  return `dispatching this order requires ${required} trust (caller is ${caller})`
}

/** Dedupe preserving first-seen order, matching `unattended-permissions.ts`. */
function uniq(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * The synthetic request the trust gate judges.
 *
 * `cwd` is a placeholder: `evaluateSpawnPermission` never reads it, and giving
 * it a real path here would imply this module knows where the seat runs, which
 * it deliberately does not.
 */
function effectiveRequest(mode: OrderCaps['permissionMode']): SpawnRequest {
  return { cwd: '.', ...(mode ? { permissionMode: mode } : {}) }
}

/**
 * SELECTION fields: explicit base wins, the order fills the gap.
 *
 * Written as a table walk rather than four near-identical `if`s so adding a
 * fifth selection field is one entry, not a copied line somebody forgets to
 * copy into the caps type as well.
 */
const SELECTION_KEYS = ['model', 'effort', 'agent', 'mcpConfigPath'] as const

function selectionCaps(order: Order, base: OrderCapBase): ComposedOrderCaps {
  const out: ComposedOrderCaps = {}
  for (const key of SELECTION_KEYS) {
    const value = base[key] ?? order.caps[key]
    if (value !== undefined) Object.assign(out, { [key]: value })
  }
  return out
}

/** The refusal, with the order named so a log line says WHICH seat asked. */
function refusal(order: Order, verdict: Extract<SpawnEvalResult, { ok: false }>): OrderCapResult {
  const field = verdict.kind === 'reject' ? (verdict.field ?? 'permissionMode') : 'permissionMode'
  return { ok: false, reason: `order ${order.id}: ${verdict.reason}`, field }
}

/**
 * Compose one order's caps against a base, under a caller's trust.
 *
 * Returns `{ ok: false }` when the order asks for MORE privilege than the
 * caller holds -- today that is exactly `bypassPermissions` from a
 * non-benevolent caller, because that is the rule `evaluateSpawnPermission`
 * enforces and this function refuses to keep its own copy of it.
 */
export function composeOrderCaps(order: Order, base: OrderCapBase, caller: SpawnCallerContext): OrderCapResult {
  const underTrusted = belowMinTrust(order, caller.trustLevel)
  if (underTrusted !== null) return { ok: false, reason: `order ${order.id}: ${underTrusted}`, field: 'minTrust' }

  const mode = narrowestMode(base.permissionMode, order.caps.permissionMode)
  // The composed mode goes through the REAL gate. The caller context is passed
  // through untouched: an order cannot supply, spoof or improve it.
  const verdict = evaluateSpawnPermission(caller, effectiveRequest(mode))
  if (!verdict.ok) return refusal(order, verdict)

  const caps: ComposedOrderCaps = selectionCaps(order, base)
  // PRIVILEGE -- narrow only.
  const budget = narrowest(base.maxBudgetUsd, order.caps.maxBudgetUsd)
  if (budget !== undefined) caps.maxBudgetUsd = budget
  const turns = narrowest(base.maxTurns, order.caps.maxTurns)
  if (turns !== undefined) caps.maxTurns = turns
  if (mode !== undefined) caps.permissionMode = mode
  // CAPABILITY -- add only.
  const deny = uniq([...(base.deny ?? []), ...(order.permissions?.deny ?? [])])
  if (deny.length > 0) caps.deny = deny
  return { ok: true, caps }
}

/** Thrown by {@link composeOrderCapsOrThrow} when an order asks to widen. */
export class OrderCapsError extends Error {
  field: string
  constructor(reason: string, field: string) {
    super(reason)
    this.name = 'OrderCapsError'
    this.field = field
  }
}

/**
 * {@link composeOrderCaps}, for a call site whose signature has no room for a
 * result type -- the epic spawn planners, whose exported shape is fixed.
 *
 * THROWING IS THE RIGHT FAILURE HERE. A refusal means the order asked for more
 * privilege than the caller holds, and there is no degraded seat to dispatch
 * instead: silently narrowing to what the caller does hold would spawn a worker
 * that cannot do the job its order describes, and nothing downstream would say
 * why.
 */
export function composeOrderCapsOrThrow(
  order: Order,
  base: OrderCapBase,
  caller: SpawnCallerContext,
): ComposedOrderCaps {
  const result = composeOrderCaps(order, base, caller)
  if (!result.ok) throw new OrderCapsError(result.reason, result.field)
  return result.caps
}

/**
 * The caller context an engine-internal dispatch composes against.
 *
 * The default is `benevolent` because this is a PLANNING step and the real gate
 * runs later, at `dispatchSpawn`, against the caller's actual context -- see
 * `EpicSpawnCtx.trustLevel` in `epic-spawn-plan.ts` for why that is not a hole.
 * A caller that knows its trust passes it and gets the refusal early.
 */
export function internalOrderCaller(trustLevel: TrustLevel = 'benevolent'): SpawnCallerContext {
  return { kind: 'ws', hasSpawnPermission: true, trustLevel, callerProject: null }
}

/**
 * `order@1` -- A WORK ORDER: the SEAT, as an artifact.
 *
 * Until now a seat lived in two places that were both wrong: prose inside a
 * board card ("READ THIS FIRST, VERIFIER"), and a prompt builder hardcoded in
 * the broker. There were exactly four seats in the system and not one of them
 * was a thing you could read, diff, version or cap.
 *
 * An order is the reusable half of a dispatch:
 *
 *     CARD  (what to build -- card-specific, written once)
 *       +
 *     ORDER (who builds it -- reusable, versioned, capped)
 *       =>  the dispatched seat's prompt + spawn config
 *
 * WHAT THIS FILE IS NOT, YET: there is no URL fetch, no redirect ladder and no
 * gallery here. Importing an order from a `claudewerk://order?src=` link is a
 * separate card (`werk-work-orders-share`) precisely because that is where the
 * SSRF surface lives. The validation below is nonetheless written as if the
 * input were hostile, because the day an order arrives over a wire is the day
 * this validation is the only thing standing there, and validation retrofitted
 * after the first untrusted caller is validation nobody trusts.
 *
 * THE SECURITY REASONING IS BORROWED, DELIBERATELY, from munder-difflin's
 * `hire@1` manifest -- the best-reasoned code in that repo:
 *
 *   1. DEFAULT-DENY FLAG ALLOWLIST. Their note is worth quoting: a manifest's
 *      provider is attacker-chosen and each CLI keeps adding flags, so a
 *      denylist of "dangerous" flags drifts and leaks -- three rounds of
 *      re-review each found one more spelling that escaped. Default-deny closes
 *      the CLASS instead of chasing spellings. See `ORDER_FLAG_ALLOWLIST`.
 *
 *   2. REJECT SHELL METACHARACTERS in any string that reaches a command line,
 *      reasoned from Windows `.cmd` shims that route through cmd.exe, where an
 *      unquoted `&` / `|` / `^` chains a second command. Implemented here as a
 *      CHARACTER ALLOWLIST rather than a metachar denylist -- for exactly the
 *      reason in (1). A denylist of metachars drifts the same way a denylist of
 *      flags does. See `isCommandLineSafe`.
 *
 *   3. AN ORDER NEVER AUTO-SPAWNS. It is validated and it pre-fills; a seat is
 *      dispatched by the engine or submitted by a human, never by the artifact.
 *      Nothing in this module spawns anything, and nothing downstream may treat
 *      a validated order as an instruction to launch.
 *
 * THIS MODULE KNOWS NOTHING ABOUT THE EPIC ENGINE, and that is the point of the
 * `order-seat-union-is-closed` revision. `seat` used to be a closed union over
 * the epic engine's four seats and `prompt` had to name one of the broker's four
 * prompt builders, so "a fifth seat type is cheap" -- the win `werk-work-orders`
 * claimed -- was false: REVIEWER, MERGER, DOC-WRITER, TRIAGE each still meant
 * editing this file AND the broker. A seat is now any lowercase-kebab name, and
 * an order that no builder covers carries its own `instructions`. Which of those
 * names the EPIC engine will actually dispatch is the epic engine's business,
 * declared in `epic-orders.ts` and enforced by `orderRole()` -- see there.
 */

/** The schema discriminator. Bump the number, never the meaning of a number. */
export const ORDER_KIND = 'order@1' as const

/**
 * Which seat an order fills. AN OPEN NAME, not a union.
 *
 * Nothing here enumerates the legal seats, because the seat an order fills is
 * decided by whoever DISPATCHES it, not by the schema: the epic engine spends
 * `overseer` / `planner` / `implementer` / `verifier` (`EPIC_ORDERS`), the
 * scheduler spends its own, and neither one gets to shrink the other's
 * vocabulary. The alias exists so the intent has a name and a future narrowing
 * has exactly one place to happen.
 *
 * The FORM is still checked -- see {@link ORDER_SEAT} -- because a seat name is
 * read by humans in a picker and joined into conversation names.
 */
export type OrderSeat = string

/** Thinking-effort tiers, mirroring the spawn schema's `effort`. */
export type OrderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Permission modes an order is allowed to name. Deliberately a SHORT list. */
export type OrderPermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions'

/**
 * Caller trust levels an order may demand, mirroring `spawn-permissions.ts`'
 * `TrustLevel` -- spelled out here for the same reason {@link OrderPermissionMode}
 * is, so this schema file keeps its zero imports and an order stays readable
 * without chasing another module. `order-caps.ts` binds the two: it enforces
 * this field against the real `TrustLevel`, so a drift is a type error there
 * rather than a silently unenforced rule here.
 */
export type OrderTrustLevel = 'untrusted' | 'trusted' | 'benevolent'

/** The trust ladder, least to most. Ordering is what makes "at least" checkable. */
export const ORDER_TRUST_RANK: Record<OrderTrustLevel, number> = { untrusted: 0, trusted: 1, benevolent: 2 }

/**
 * Every CLI flag an order may set through the raw `flags` escape hatch.
 *
 * DEFAULT-DENY, and the list is short on purpose. These five are the ones a
 * ROLE legitimately decides: which model, how hard it thinks, which agent
 * definition it wears, and the two ceilings it may not exceed -- money and
 * turns. Everything else about the launch is decided by the engine
 * (`--output-format`, `--verbose`, `--permission-mode`, `--settings`,
 * `--mcp-config`, `--worktree`) and an order that could set those would be
 * rewriting the harness rather than describing a role.
 *
 * `--max-turns` IS ON THE LIST FOR THE SAME REASON `--max-budget-usd` IS: both
 * are hard stops on a seat that nobody is watching, and both narrow only. It is
 * a hidden CC flag (`docs/stream-json-protocol.md`) but a real one -- an unknown
 * flag is a hard `error: unknown option` from the CLI, so a spelling that did
 * not exist would kill the spawn rather than be ignored.
 *
 * Prefer the typed `caps` fields; `flags` exists so a new CC flag is reachable
 * without a schema change, and it is the surface an attacker would aim at.
 */
export const ORDER_FLAG_ALLOWLIST: readonly string[] = [
  '--model',
  '--effort',
  '--agent',
  '--max-budget-usd',
  '--max-turns',
]

/**
 * The characters a string may contain when it will end up in an argv.
 *
 * ALLOWLIST, NOT DENYLIST -- see the header. What is permitted is what real
 * values actually need: model slugs (`claude-opus-5[1m]`), flag names
 * (`--max-budget-usd`), branch and worktree fragments (`epic/e/card`), name
 * prefixes (`verify `). Everything a shell or a cmd.exe shim would treat as
 * syntax -- `; & | ` $ ( ) { } < > ^ % ! ' " \` and any newline -- is absent,
 * and absent by construction rather than by enumeration.
 */
const COMMAND_LINE_SAFE = /^[\w .@:/[\]-]+$/

/** Does this string survive reaching a command line unquoted? */
export function isCommandLineSafe(value: string): boolean {
  return value.length > 0 && COMMAND_LINE_SAFE.test(value)
}

/**
 * Caps and selections a role carries.
 *
 * TWO KINDS OF FIELD, and the distinction decides how they compose (see
 * `order-caps.ts`): `maxBudgetUsd`, `maxTurns` and `permissionMode` are
 * PRIVILEGE -- they may only ever be narrowed. `model`, `effort`, `agent` and
 * `mcpConfigPath` are SELECTION -- there is no ladder to climb, so the explicit
 * choice of whoever runs the order wins and the order supplies the default.
 *
 * EVERY FIELD HERE IS A SPAWN FIELD -- it maps onto a `SpawnRequest` and rides
 * to a seat. The seat's share of the SCHEDULER'S POOL is not one of them and
 * lives on {@link Order.reservation} instead: `composeOrderCaps` would have no
 * answer for how a pool share composes onto a spawn request, because it does
 * not compose onto one at all.
 */
export interface OrderCaps {
  /** CC model slug. A GUARD reading a diff does not need the tier a builder does. */
  model?: string
  effort?: OrderEffort
  /** `--agent`: which agent definition the seat wears. */
  agent?: string
  /** Hard spend ceiling for ONE seat. `werk-run-caps` bounds the RUN; this bounds the seat. */
  maxBudgetUsd?: number
  /**
   * Hard TURN ceiling for one seat, as CC's `--max-turns`.
   *
   * THE SECOND HALF OF "WHAT A ROLE MAY SPEND", and it catches what a budget
   * cannot: a seat that is cheap per turn and wrong about when to stop. A
   * refiner still going at 30 turns has stopped refining and started
   * implementing, and it can do that for a long time inside $0.50.
   *
   * A POSITIVE INTEGER. A count of turns has no fractional value, so `2.5` is a
   * typo rather than a cap, and `0` is a seat that cannot take its first turn --
   * which is a schedule that should be disabled, said in a place nothing reads.
   */
  maxTurns?: number
  /** The permission mode the seat runs at. Narrowing only, and `bypassPermissions`
   *  stays benevolent-only -- enforced in `order-caps.ts`, not here. */
  permissionMode?: OrderPermissionMode
  /** Absolute path to an MCP config JSON, so a role can declare which servers it reaches. */
  mcpConfigPath?: string
}

/**
 * Extra permission rules an order layers on the unattended floor.
 *
 * THERE IS NO `allow` FIELD, AND THAT IS THE FEATURE. An order can only ever
 * take capability away. If an imported role could add an allow rule, the first
 * hostile order would simply grant itself the tool it wanted; a role that needs
 * a wider allowlist is a change to the project's own unattended config, made by
 * a human, in a file an order cannot reach.
 */
export interface OrderPermissions {
  /** Additional CC deny rules, unioned onto the deny-floor. */
  deny?: string[]
}

/**
 * The worktree an order's seat gets. Absent means NO worktree at all -- the
 * overseer and the planner judge and edit main, and an isolated checkout would
 * hide the very state they exist to read.
 */
export interface OrderWorktree {
  /** Prepended to the card id, e.g. `verify-`. Empty string for the plain case. */
  prefix: string
}

/** `order@1`, the artifact. */
export interface Order {
  kind: typeof ORDER_KIND
  /** Stable id, `NAME@VERSION` -- e.g. `IMPLEMENTER@1`. */
  id: string
  /** One line a human reads in a picker. */
  title: string
  /** Which seat this order fills. Lowercase-kebab, and OPEN -- see {@link OrderSeat}. */
  seat: OrderSeat
  /**
   * The broker prompt builder that compiles a card into this seat's prompt,
   * NAMED rather than referenced. The four builders take four different context
   * types, so a union-typed dispatch would buy nothing but a cast; the planners
   * still call their builder directly and a test asserts the declaration and
   * the call agree. The name is here so an order is READABLE -- "which prompt
   * does GUARD@1 use" should not require reading the broker.
   *
   * EXACTLY ONE OF `prompt` AND `instructions` IS SET. A seat whose prompt no
   * builder covers carries {@link Order.instructions} instead; requiring one of
   * the two means an order always says where its prompt comes from, which is
   * the readable property this whole file exists for.
   */
  prompt?: 'implementer' | 'guard' | 'overseer' | 'planner'
  /**
   * This seat's instruction block, carried BY THE ORDER, for a seat no broker
   * builder covers.
   *
   * THIS IS THE HALF THAT MAKES A NEW SEAT CHEAP. Before it, an order could only
   * point at one of four builders compiled into the broker, so a REFINER or a
   * DOC-WRITER had no way to carry what it was supposed to do -- {@link
   * Order.notes} is prose for a human and reaches no agent. `REFINER@1` shipped
   * as `seat: 'implementer', prompt: 'implementer'` with its real instructions
   * in a wrapper type beside the order, for exactly this reason.
   *
   * IT IS PROMPT PAYLOAD, NOT ARGV, and the argv character allowlist is
   * deliberately NOT applied -- an instruction block is numbered lists,
   * backticks and newlines, so `isCommandLineSafe` would reject every real one,
   * which is how a security check gets switched off wholesale six months later.
   * What IS checked is the class that matters for a payload: a length bound, and
   * control characters that are not ordinary whitespace (a NUL or a bare ESC in
   * an imported order is terminal-injection, not instruction).
   */
  instructions?: string
  /** Prepended to the conversation name, e.g. `verify `. */
  namePrefix?: string
  /** Absent = this seat gets no worktree. */
  worktree?: OrderWorktree
  caps: OrderCaps
  /**
   * How many of a dispatcher's concurrent slots this order may hold AT ONCE.
   *
   * THE POOL IS THE DISPATCHER'S, THE SHARE IS THE ORDER'S. The scheduler caps
   * itself at `MAX_CONCURRENT_SCHEDULED_SPAWNS` (3) globally -- enough to stop
   * the scheduler eating the machine, and not enough to stop ONE role eating the
   * scheduler. A backlog of 40 `#needs-refine` cards and a `REFINER@1` schedule
   * holds all three for as long as the backlog lasts, and the nightly board
   * sweep -- one fire, one minute, no retry -- is simply skipped, in a way that
   * looks exactly like every other overlap skip in the history.
   *
   * IT IS NOT IN {@link OrderCaps} AND THAT IS THE POINT. Every field in `caps`
   * maps onto a `SpawnRequest` and narrows what ONE seat may do; this one is
   * about how many seats there may be, which is a question no spawn request can
   * answer. `composeOrderCaps` would have to invent a composition rule for a
   * field it can never write anywhere.
   *
   * ABSENT MEANS NO RESERVATION -- the dispatcher's own ceiling is the only
   * bound, which is the status quo for every schedule that never heard of
   * orders. `0` is legal and means PARKED: an order that may hold no slot at
   * all, which is how a role is taken out of service without deleting it.
   * See `src/broker/scheduled-tasks/seat-reservation.ts` for the decision.
   */
  reservation?: number
  /**
   * The LOWEST caller trust that may dispatch this order at all.
   *
   * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   * ┃  WHO MAY RUN THE SEAT IS A SEPARATE QUESTION FROM WHAT THE SEAT MAY DO. ┃
   * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
   *
   * It was not separate until 2026-08-22, and that was an accident nobody chose.
   * Every shipped order declared `permissionMode: 'bypassPermissions'`, and
   * `evaluateSpawnPermission` refuses bypass from a non-benevolent caller -- so
   * "only a benevolent caller may start an epic" was true, but only as a SIDE
   * EFFECT of the mode. Narrowing the seats to `auto` -- strictly less privilege
   * -- would therefore have silently WIDENED who may start one, because there
   * was no longer a bypass to refuse. A change that reduces privilege must not
   * be able to remove an access control by accident, so the control is written
   * down here and enforced on its own terms.
   *
   * ABSENT MEANS NO REQUIREMENT: an order that says nothing is dispatchable by
   * anyone the ordinary spawn gate already lets through. The shipped fleet
   * orders all name `benevolent`, which is exactly the trust they held before.
   */
  minTrust?: OrderTrustLevel
  /** Raw flag escape hatch. Default-deny against `ORDER_FLAG_ALLOWLIST`. */
  flags?: Record<string, string>
  permissions?: OrderPermissions
  /**
   * Free prose for a human reading the order. Never reaches a command line AND
   * never reaches an agent -- {@link Order.instructions} is the field an agent
   * is handed.
   */
  notes?: string
}

/**
 * The prompt a seat actually launches with: WHAT to do, then WHO is doing it.
 *
 * THIS IS THE FUNCTION THAT MAKES {@link Order.instructions} REAL. A field that
 * validates and reaches no spawn is the same inertness `REFINER@1`'s wrapper
 * type already shipped once, with a nicer type on it -- so the schema half of
 * "a new seat is cheap" is only true once something turns the block into prompt
 * text. An order that NAMES a builder returns `context` untouched: the builder
 * produced the whole prompt and there is nothing to fold in.
 *
 * CONTEXT FIRST, INSTRUCTIONS SECOND, matching the one hand-rolled composition
 * that predates this function (`refine-scanner.ts`'s `buildRefinerPrompt`:
 * which card, then the block verbatim). The context is the half that changes per
 * dispatch -- which card, which minute, which project -- and the instruction
 * block is the standing half, so a seat reads its standing rules against a
 * target it already has rather than the other way round.
 *
 * IT APPENDS, IT DOES NOT REPLACE. Dropping the caller's own context in favour
 * of the order's block would silently discard the one thing a human wrote for
 * this particular dispatch, which for a scheduled fire is the prompt the schema
 * makes mandatory.
 */
export function composeSeatPrompt(order: Order | undefined, context: string): string {
  const instructions = order?.instructions
  if (instructions === undefined) return context
  return context.length === 0 ? instructions : `${context}\n\n${instructions}`
}

/** Thrown by {@link validateOrder}. `field` names the offending path. */
export class OrderValidationError extends Error {
  field: string
  constructor(message: string, field: string) {
    super(message)
    this.name = 'OrderValidationError'
    this.field = field
  }
}

const EFFORTS: readonly OrderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly OrderPermissionMode[] = ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']

const TRUST_LEVELS: readonly OrderTrustLevel[] = ['untrusted', 'trusted', 'benevolent']
const PROMPTS: readonly NonNullable<Order['prompt']>[] = ['implementer', 'guard', 'overseer', 'planner']

/** `NAME@VERSION`, upper-kebab name and an integer version. */
const ORDER_ID = /^[A-Z][A-Z0-9-]*@\d+$/

/**
 * A seat NAME: lowercase kebab, starts with a letter.
 *
 * The seat union is open (see {@link OrderSeat}), so this is what stands in for
 * it. Strictly narrower than {@link COMMAND_LINE_SAFE}, so a seat name is
 * argv-safe by construction rather than by a second check -- `Refiner`,
 * `refiner_2` and `refiner; id` are all refused, and one canonical spelling per
 * seat is what keeps `EPIC_ORDERS`-style lookups from missing on case.
 */
const ORDER_SEAT = /^[a-z][a-z0-9-]*$/

/** Longest a seat name may be. A label in a picker, not a sentence. */
const SEAT_MAX = 32

/**
 * Longest an instruction block may be.
 *
 * A bound rather than a right number: nothing today comes close (`REFINER@1`'s
 * block is well under a kilobyte), and the reason to have one at all is that the
 * day an order arrives over a wire, an unbounded string field is the cheapest
 * way to make a spawn carry a megabyte of someone else's text.
 */
export const ORDER_INSTRUCTIONS_MAX = 20_000

/**
 * Does this string carry a control character that is not ordinary whitespace?
 *
 * Written as a code-point scan rather than a regex literal on purpose: the
 * escape-heavy character class this replaces is unreadable, and a reviewer
 * cannot tell one hex escape from a neighbouring one at a glance. Tab, newline
 * and carriage return are the three that belong in an instruction block;
 * everything below `0x20`, plus `DEL`, is a payload trying to be a terminal.
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) as number
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function fail(message: string, field: string): never {
  throw new OrderValidationError(message, field)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`, key)
  return value
}

/** A string destined for an argv. Rejects the whole CLASS, not a list of spellings. */
function requireCommandLineSafe(value: string, field: string): string {
  if (!isCommandLineSafe(value)) fail(`${field} contains characters that may not reach a command line`, field)
  return value
}

/**
 * The SEAT, which is an open name rather than a member of a union.
 *
 * The check is on the FORM, and it is what replaced the closed union: `seat`
 * used to be validated against a hardcoded list of the epic engine's four,
 * which is precisely why a fifth seat type was not cheap. Whether a given
 * well-formed seat is one the EPIC engine will dispatch is asked separately, of
 * `epic-orders.ts`, and asking it here would put the epic engine back inside the
 * generic schema.
 */
function validateSeat(raw: Record<string, unknown>): OrderSeat {
  const seat = requireString(raw, 'seat')
  if (seat.length > SEAT_MAX) fail(`seat must be at most ${SEAT_MAX} characters`, 'seat')
  if (!ORDER_SEAT.test(seat)) fail('seat must be a lowercase-kebab name, e.g. implementer or doc-writer', 'seat')
  return seat
}

/**
 * `prompt` XOR `instructions` -- where this seat's prompt comes from.
 *
 * NEITHER is refused rather than defaulted: an order that names no builder and
 * carries no text is an order nobody can dispatch, and silently picking
 * `implementer` for it is how `REFINER@1` came to declare a seat it does not
 * fill. BOTH is refused because the two would then disagree and nothing says
 * which wins.
 */
function validatePromptSource(raw: Record<string, unknown>): Pick<Order, 'prompt' | 'instructions'> {
  const prompt = optionalMember(raw, 'prompt', PROMPTS, 'prompt')
  const rawInstructions = raw.instructions
  if (rawInstructions !== undefined && typeof rawInstructions !== 'string') {
    fail('instructions must be a string', 'instructions')
  }
  const instructions = rawInstructions as string | undefined

  if (prompt !== undefined && instructions !== undefined) {
    fail('an order sets either prompt or instructions, never both', 'instructions')
  }
  if (prompt === undefined && instructions === undefined) {
    fail(`an order must set prompt (one of: ${PROMPTS.join(', ')}) or instructions`, 'prompt')
  }
  if (instructions === undefined) return { prompt }

  if (instructions.length === 0) fail('instructions must be a non-empty string', 'instructions')
  if (instructions.length > ORDER_INSTRUCTIONS_MAX) {
    fail(`instructions must be at most ${ORDER_INSTRUCTIONS_MAX} characters`, 'instructions')
  }
  // NOT the argv allowlist -- see Order.instructions. Newlines and backticks are
  // what an instruction block is MADE of; a NUL or a bare ESC is not.
  if (hasControlChars(instructions)) {
    fail('instructions may not contain control characters other than tab, newline and carriage return', 'instructions')
  }
  return { instructions }
}

function optionalMember<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  field: string,
): T | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${field} must be one of: ${allowed.join(', ')}`, field)
  }
  return value as T
}

function optionalSafeString(record: Record<string, unknown>, key: string, field: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(`${field} must be a string`, field)
  return requireCommandLineSafe(value, field)
}

/**
 * A COUNT: an integer at or above `min`, or absent.
 *
 * Integer-checked rather than merely positive, because every count in an order
 * is of a discrete thing -- turns taken, slots held. `maxTurns: 2.5` and
 * `reservation: 1.5` are typos that a `> 0` check would wave through into a
 * comparison that then behaves like 2 in one place and 1 in another.
 */
function optionalCount(record: Record<string, unknown>, key: string, field: string, min: number): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    fail(`${field} must be an integer >= ${min}`, field)
  }
  return value as number
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`, field)
  return value as Record<string, unknown>
}

/** Assign only when the value is present, so an absent field stays absent
 *  rather than becoming an explicit `undefined` key in the emitted object. */
function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value
}

function validateCaps(input: unknown): OrderCaps {
  if (input === undefined) return {}
  const raw = asRecord(input, 'caps')
  const budget = raw.maxBudgetUsd
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0)) {
    fail('caps.maxBudgetUsd must be a positive finite number', 'caps.maxBudgetUsd')
  }
  const caps: OrderCaps = {}
  put(caps, 'model', optionalSafeString(raw, 'model', 'caps.model'))
  put(caps, 'effort', optionalMember(raw, 'effort', EFFORTS, 'caps.effort'))
  put(caps, 'agent', optionalSafeString(raw, 'agent', 'caps.agent'))
  put(caps, 'maxBudgetUsd', budget as number | undefined)
  // At least ONE turn. A zero-turn seat is a seat that cannot answer its own
  // prompt, and a schedule that means to dispatch nothing says so by being
  // disabled -- not by capping its role at a turn count nothing can use.
  put(caps, 'maxTurns', optionalCount(raw, 'maxTurns', 'caps.maxTurns', 1))
  put(caps, 'permissionMode', optionalMember(raw, 'permissionMode', MODES, 'caps.permissionMode'))
  put(caps, 'mcpConfigPath', optionalSafeString(raw, 'mcpConfigPath', 'caps.mcpConfigPath'))
  return caps
}

/**
 * THE ESCAPE HATCH, and the place a hostile order aims.
 *
 * Both halves are checked: the flag NAME against the default-deny allowlist,
 * and the VALUE against the command-line character allowlist. Checking only the
 * name leaves `--model 'x; curl evil'`; checking only the value leaves
 * `--dangerously-skip-permissions`.
 */
function validateFlags(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined
  const raw = asRecord(input, 'flags')
  const out: Record<string, string> = {}
  for (const [flag, value] of Object.entries(raw)) {
    if (!ORDER_FLAG_ALLOWLIST.includes(flag)) {
      fail(`flag "${flag}" is not on the order flag allowlist (${ORDER_FLAG_ALLOWLIST.join(' ')})`, `flags.${flag}`)
    }
    if (typeof value !== 'string') fail(`flags.${flag} must be a string`, `flags.${flag}`)
    out[flag] = requireCommandLineSafe(value, `flags.${flag}`)
  }
  return out
}

function validatePermissions(input: unknown): OrderPermissions | undefined {
  if (input === undefined) return undefined
  const raw = asRecord(input, 'permissions')
  if (raw.allow !== undefined) {
    fail('permissions.allow is not part of order@1 -- an order may only ever REMOVE capability', 'permissions.allow')
  }
  if (raw.deny === undefined) return {}
  if (!Array.isArray(raw.deny) || raw.deny.some(rule => typeof rule !== 'string' || rule.length === 0)) {
    fail('permissions.deny must be an array of non-empty strings', 'permissions.deny')
  }
  // Deny rules land in a settings JSON file, never an argv, so they legitimately
  // carry `(`, `:` and `*` (`Bash(bun test:*)`). The command-line allowlist is
  // deliberately NOT applied here -- applying it would reject every real rule.
  return { deny: [...(raw.deny as string[])] }
}

function validateWorktree(input: unknown): OrderWorktree | undefined {
  if (input === undefined) return undefined
  const raw = asRecord(input, 'worktree')
  const prefix = raw.prefix
  if (typeof prefix !== 'string') fail('worktree.prefix must be a string', 'worktree.prefix')
  // Empty is the ordinary case (an implementer's worktree is just the card id),
  // so only a non-empty prefix is checked against the argv allowlist.
  if (prefix.length > 0) requireCommandLineSafe(prefix, 'worktree.prefix')
  return { prefix }
}

/**
 * Validate an unknown value as an `order@1`, or throw {@link OrderValidationError}.
 *
 * Returns a FRESH object built field by field -- never the input with a cast.
 * An unknown key on the input is dropped rather than carried, so a field added
 * by a future version cannot ride through this validator into a spawn.
 */
export function validateOrder(input: unknown): Order {
  const raw = asRecord(input, 'order')
  if (raw.kind !== ORDER_KIND) fail(`kind must be "${ORDER_KIND}"`, 'kind')

  const id = requireString(raw, 'id')
  if (!ORDER_ID.test(id)) fail('id must look like NAME@VERSION, e.g. IMPLEMENTER@1', 'id')

  const seat = validateSeat(raw)
  const source = validatePromptSource(raw)

  const order: Order = {
    kind: ORDER_KIND,
    id,
    title: requireString(raw, 'title'),
    seat,
    caps: validateCaps(raw.caps),
  }
  put(order, 'prompt', source.prompt)
  put(order, 'instructions', source.instructions)
  // ZERO IS LEGAL HERE, unlike `caps.maxTurns`: a parked order holding no slot
  // is a role taken out of service, which is a thing somebody means.
  put(order, 'reservation', optionalCount(raw, 'reservation', 'reservation', 0))
  put(order, 'namePrefix', optionalSafeString(raw, 'namePrefix', 'namePrefix'))
  put(order, 'worktree', validateWorktree(raw.worktree))
  put(order, 'minTrust', optionalMember(raw, 'minTrust', TRUST_LEVELS, 'minTrust'))
  put(order, 'flags', validateFlags(raw.flags))
  put(order, 'permissions', validatePermissions(raw.permissions))
  put(order, 'notes', typeof raw.notes === 'string' ? raw.notes : undefined)
  return order
}

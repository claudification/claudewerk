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
 */

/** The schema discriminator. Bump the number, never the meaning of a number. */
export const ORDER_KIND = 'order@1' as const

/** Which of the engine's seats an order fills. */
export type OrderSeat = 'overseer' | 'planner' | 'implementer' | 'verifier'

/** Thinking-effort tiers, mirroring the spawn schema's `effort`. */
export type OrderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Permission modes an order is allowed to name. Deliberately a SHORT list. */
export type OrderPermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions'

/**
 * Every CLI flag an order may set through the raw `flags` escape hatch.
 *
 * DEFAULT-DENY, and the list is short on purpose. These four are the ones a
 * ROLE legitimately decides: which model, how hard it thinks, which agent
 * definition it wears, and what it may spend. Everything else about the launch
 * is decided by the engine (`--output-format`, `--verbose`, `--permission-mode`,
 * `--settings`, `--mcp-config`, `--worktree`) and an order that could set those
 * would be rewriting the harness rather than describing a role.
 *
 * Prefer the typed `caps` fields; `flags` exists so a new CC flag is reachable
 * without a schema change, and it is the surface an attacker would aim at.
 */
export const ORDER_FLAG_ALLOWLIST: readonly string[] = ['--model', '--effort', '--agent', '--max-budget-usd']

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
 * `order-caps.ts`): `maxBudgetUsd` and `permissionMode` are PRIVILEGE -- they
 * may only ever be narrowed. `model`, `effort`, `agent` and `mcpConfigPath` are
 * SELECTION -- there is no ladder to climb, so the explicit choice of whoever
 * runs the order wins and the order supplies the default.
 */
export interface OrderCaps {
  /** CC model slug. A GUARD reading a diff does not need the tier a builder does. */
  model?: string
  effort?: OrderEffort
  /** `--agent`: which agent definition the seat wears. */
  agent?: string
  /** Hard spend ceiling for ONE seat. `werk-run-caps` bounds the RUN; this bounds the seat. */
  maxBudgetUsd?: number
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
  /** Which seat this order fills. */
  seat: OrderSeat
  /**
   * The prompt builder that compiles a card into this seat's prompt, NAMED
   * rather than referenced. The four builders take four different context
   * types, so a union-typed dispatch would buy nothing but a cast; the planners
   * still call their builder directly and a test asserts the declaration and
   * the call agree. The name is here so an order is READABLE -- "which prompt
   * does GUARD@1 use" should not require reading the broker.
   */
  prompt: 'implementer' | 'guard' | 'overseer' | 'planner'
  /** Prepended to the conversation name, e.g. `verify `. */
  namePrefix?: string
  /** Absent = this seat gets no worktree. */
  worktree?: OrderWorktree
  caps: OrderCaps
  /** Raw flag escape hatch. Default-deny against `ORDER_FLAG_ALLOWLIST`. */
  flags?: Record<string, string>
  permissions?: OrderPermissions
  /** Free prose for a human reading the order. Never reaches a command line. */
  notes?: string
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

const SEATS: readonly OrderSeat[] = ['overseer', 'planner', 'implementer', 'verifier']
const EFFORTS: readonly OrderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly OrderPermissionMode[] = ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']
const PROMPTS: readonly Order['prompt'][] = ['implementer', 'guard', 'overseer', 'planner']

/** `NAME@VERSION`, upper-kebab name and an integer version. */
const ORDER_ID = /^[A-Z][A-Z0-9-]*@\d+$/

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

  const seat = optionalMember(raw, 'seat', SEATS, 'seat')
  if (!seat) fail(`seat must be one of: ${SEATS.join(', ')}`, 'seat')
  const prompt = optionalMember(raw, 'prompt', PROMPTS, 'prompt')
  if (!prompt) fail(`prompt must be one of: ${PROMPTS.join(', ')}`, 'prompt')

  const order: Order = {
    kind: ORDER_KIND,
    id,
    title: requireString(raw, 'title'),
    seat,
    prompt,
    caps: validateCaps(raw.caps),
  }
  put(order, 'namePrefix', optionalSafeString(raw, 'namePrefix', 'namePrefix'))
  put(order, 'worktree', validateWorktree(raw.worktree))
  put(order, 'flags', validateFlags(raw.flags))
  put(order, 'permissions', validatePermissions(raw.permissions))
  put(order, 'notes', typeof raw.notes === 'string' ? raw.notes : undefined)
  return order
}

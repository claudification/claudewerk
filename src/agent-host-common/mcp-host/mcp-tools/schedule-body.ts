/**
 * Turning tool params into the bodies the broker's schema accepts.
 *
 * Two of these defaults are silent when wrong and only discovered at 03:00, so
 * they live here together rather than inline in the tool handlers:
 *
 *   - the TIMEZONE comes from the AGENT HOST, never the broker (which runs
 *     UTC), because an unzoned schedule fires at the wrong hour;
 *   - the DIRECTORY is the project ROOT with any `.claude/worktrees/<name>`
 *     folded away, because a schedule outlives the worktree it was created in
 *     and would then fire into a directory that no longer exists.
 *
 * MCP params arrive as STRINGS, which is why the coercions are explicit: an
 * `enabled: "false"` that reached the broker uncoerced would be truthy, and
 * "disable this schedule" would silently enable it.
 */

import { aliasPath, cwdToProjectUri } from '../../../shared/project-uri'
import { DEFAULT_SCHEDULE_SPAWN } from '../../../shared/scheduled-task'
import type { McpToolContext } from './types'

type Params = Record<string, string>

/** This host's own zone -- the closest thing to "the user's clock" available
 *  here, and categorically better than letting the UTC broker decide. */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The caller's project + directory, worktree folded back to the repo root. */
function selfProject(ctx: McpToolContext): { projectUri: string; cwd: string } | null {
  const cwd = ctx.getIdentity()?.cwd
  if (!cwd) return null
  const root = aliasPath(cwd)
  return { projectUri: cwdToProjectUri(root), cwd: root }
}

/** Drop the keys the caller never supplied, so an omitted field stays omitted
 *  rather than travelling as an explicit undefined/empty. */
function given(pairs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(pairs).filter(([, v]) => v !== undefined && v !== '' && v !== null))
}

/**
 * WHICH KIND of schedule this is. Repeating and one-shot are different things,
 * not variants -- exactly one of `cron`/`runAt` may be present, and saying so
 * here keeps the refusal specific instead of surfacing as a zod message.
 */
function whenFields(p: Params): { when: Record<string, unknown> } | { error: string } {
  if (p.cron && p.runAt) return { error: 'pass cron OR runAt, never both -- they are different kinds' }
  if (p.cron) return { when: { cron: p.cron } }
  if (p.runAt) return { when: { runAt: Number(p.runAt) } }
  return { error: 'pass cron (repeating) or runAt (one-shot) -- exactly one' }
}

/** WHERE it runs: what the caller said, else its own project's root. */
function whereFields(ctx: McpToolContext, p: Params): { projectUri: string; cwd: string } | { error: string } {
  const self = selfProject(ctx)
  const projectUri = p.projectUri || self?.projectUri
  const cwd = p.cwd || self?.cwd
  if (!projectUri || !cwd) return { error: 'projectUri and cwd are required (this host reports no cwd)' }
  return { projectUri, cwd }
}

/** A numeric param off the wire, or undefined -- MCP sends numbers as strings. */
function num(v: string | undefined): number | undefined {
  return v === undefined || v === '' ? undefined : Number(v)
}

/**
 * The `epic-start` payload, or nothing.
 *
 * Built whenever the caller named an `epic_id`, INDEPENDENTLY of `action`, so a
 * caller who filled in the epic and forgot the action gets the server's refusal
 * ("epic is only meaningful for action \"epic-start\"") rather than a schedule
 * that silently arms nothing every Saturday for a year.
 */
function epicFields(p: Params): Record<string, unknown> | undefined {
  if (!p.epic_id) return undefined
  return {
    epicId: p.epic_id,
    ...given({
      when: p.when,
      target: p.target,
      concurrency: num(p.concurrency),
      maxGens: num(p.max_gens),
      maxUsd: num(p.max_usd),
      maxWallClockMinutes: num(p.max_wall_clock_minutes),
    }),
  }
}

/** Run policy, defaulted exactly the way the control panel defaults it. */
function policyFields(p: Params): Record<string, unknown> {
  return {
    overlap: p.overlap === 'parallel' ? 'parallel' : 'skip',
    catchUp: p.catchUp === 'once' ? 'once' : 'skip',
    enabled: String(p.enabled) !== 'false',
  }
}

/** The create body: caller-supplied fields over the seeded WHERE + WHEN. */
export function createBody(ctx: McpToolContext, p: Params): Record<string, unknown> | { error: string } {
  const where = whereFields(ctx, p)
  if ('error' in where) return where
  const when = whenFields(p)
  if ('error' in when) return when

  return {
    name: p.name,
    ...where,
    tz: p.tz || hostTimeZone(),
    ...when.when,
    // `prompt` and `action` go through `given` because ABSENT and EMPTY are
    // different answers to the server's per-action rule: an `action=board-sweep`
    // carrying `prompt: ''` would be refused as a spawn with an empty prompt if
    // the key travelled, and an absent `action` is what every legacy schedule has.
    ...given({
      prompt: p.prompt,
      action: p.action,
      epic: epicFields(p),
      sentinel: p.sentinel,
      maxRuns: num(p.maxRuns),
    }),
    ...policyFields(p),
    spawn: { ...DEFAULT_SCHEDULE_SPAWN, ...given({ model: p.model }) },
  }
}

/** What `schedule_update` may change, and how each arrives off the wire. */
const PATCHABLE = [
  'name',
  'prompt',
  'action',
  'cron',
  'runAt',
  'tz',
  'cwd',
  'sentinel',
  'overlap',
  'catchUp',
  'maxRuns',
  'enabled',
] as const
const COERCE: Record<string, (v: string) => unknown> = {
  runAt: v => Number(v),
  maxRuns: v => Number(v),
  enabled: v => String(v) === 'true',
}

/**
 * ONLY the keys actually supplied, so an omitted field is left alone rather
 * than reset to a default by the merge on the other side.
 *
 * The `epic` block obeys the same rule one level down: the knobs the caller sent
 * are merged onto the ones already stored (`patchSchedule`), so raising a
 * ceiling costs one parameter and does not silently drop the epic id beside it.
 * Which is also how `epic_run action=start` behaves -- one knob changes one knob.
 */
export function patchBody(p: Params): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of PATCHABLE) {
    if (p[key] === undefined) continue
    patch[key] = COERCE[key] ? COERCE[key](p[key]) : p[key]
  }
  const epic = epicPatchFields(p)
  if (epic) patch.epic = epic
  return patch
}

/** The epic knobs a patch carries. Unlike `epicFields`, `epic_id` is NOT
 *  required: a patch that only raises `max_usd` is the common case, and the id
 *  it belongs to is already stored. */
function epicPatchFields(p: Params): Record<string, unknown> | undefined {
  const fields = given({
    ...(p.epic_id ? { epicId: p.epic_id } : {}),
    when: p.when,
    target: p.target,
    concurrency: num(p.concurrency),
    maxGens: num(p.max_gens),
    maxUsd: num(p.max_usd),
    maxWallClockMinutes: num(p.max_wall_clock_minutes),
  })
  return Object.keys(fields).length > 0 ? fields : undefined
}

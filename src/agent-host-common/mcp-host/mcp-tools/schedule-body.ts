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
    prompt: p.prompt,
    ...where,
    tz: p.tz || hostTimeZone(),
    ...when.when,
    ...given({ sentinel: p.sentinel, maxRuns: p.maxRuns ? Number(p.maxRuns) : undefined }),
    ...policyFields(p),
    spawn: { ...DEFAULT_SCHEDULE_SPAWN, ...given({ model: p.model }) },
  }
}

/** What `schedule_update` may change, and how each arrives off the wire. */
const PATCHABLE = [
  'name',
  'prompt',
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

/** ONLY the keys actually supplied, so an omitted field is left alone rather
 *  than reset to a default by the merge on the other side. */
export function patchBody(p: Params): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of PATCHABLE) {
    if (p[key] === undefined) continue
    patch[key] = COERCE[key] ? COERCE[key](p[key]) : p[key]
  }
  return patch
}

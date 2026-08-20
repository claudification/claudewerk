/**
 * Sentinel side of the standing project watch -- converge on a SET.
 *
 * The broker sends the whole set of boards this sentinel should be watching
 * (`project_watch_set`) on connect, on change, and on a heartbeat. This module
 * diffs it against the live watches and converges: start what is missing, renew
 * what is kept, tear down what left. Nothing here is edge-triggered, so a
 * dropped message costs one heartbeat rather than a permanently wrong watch.
 *
 * SOFT by design. The set is derived from conversation scopes, and plenty of
 * those are directories with no board in them at all -- a scratch dir, a repo
 * nobody runs the kanban in, a project that has since been deleted. Those are
 * ORDINARY, not faults: they are skipped, reported once, and never retried into
 * an error loop. One unwatchable entry must never cost the other thirty their
 * watches, which is the whole reason this converges per-project instead of
 * failing the batch.
 *
 * The sentinel owns URI -> path (CWD IS INFORMATIONAL): the broker sends URIs
 * and has no idea which of them exist.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CardChanged, ProjectChanged, ProjectWatchSkipReason, ProjectWatchStatus } from '../shared/protocol'
import { unwatchProject, watchedRoots, watchProject } from './project-watch'

type SendFn = (msg: ProjectChanged | CardChanged | ProjectWatchStatus) => void
type LogFn = (msg: string) => void

/** Last reported state per project URI, so a healthy fleet stays silent: a
 *  status only crosses the wire when it CHANGES, not on every heartbeat. */
const reported = new Map<string, string>()

export interface WatchSetInput {
  projects: string[]
  leaseMs: number
  /** URI -> absolute project root. May throw on an unresolvable URI. */
  resolveRoot: (project: string) => string
  send: SendFn
  log: LogFn
}

/** Report a project's state, but only the first time it reaches that state. */
function report(project: string, state: string, send: SendFn, msg: ProjectWatchStatus): void {
  if (reported.get(project) === state) return
  reported.set(project, state)
  send(msg)
}

function skip(project: string, reason: ProjectWatchSkipReason, detail: string | undefined, input: WatchSetInput): void {
  input.log(`[project-watch] skip ${project} (${reason})${detail ? `: ${detail}` : ''}`)
  report(project, reason, input.send, { type: 'project_watch_status', project, ok: false, reason, detail })
}

/**
 * Start or renew ONE project. Returns its resolved root when the watch is live,
 * or null when it was skipped -- the caller uses that to build the keep-set.
 */
function converge(project: string, input: WatchSetInput): string | null {
  let root: string
  try {
    root = input.resolveRoot(project)
  } catch (err) {
    skip(project, 'unresolvable', String(err), input)
    return null
  }

  // Re-checked on EVERY set (not cached): a project that grows a board later
  // joins on the next heartbeat instead of staying dark until a restart.
  if (!existsSync(join(root, '.rclaude', 'project'))) {
    skip(project, 'no-board', undefined, input)
    return null
  }

  try {
    watchProject(root, project, input.leaseMs, input.send, input.log)
  } catch (err) {
    skip(project, 'error', String(err), input)
    return null
  }
  report(project, 'ok', input.send, { type: 'project_watch_status', project, ok: true })
  return root
}

/**
 * Converge the live watches onto `input.projects`.
 *
 * Watches started by the viewer path (`project_watch`) for a project OUTSIDE the
 * set are deliberately left alone -- the broker's set is the union of standing
 * and viewed projects, so anything genuinely still wanted is in it; anything
 * absent has been released by both sources and should stop.
 */
export function applyProjectWatchSet(input: WatchSetInput): void {
  const keep = new Set<string>()
  for (const project of input.projects) {
    const root = converge(project, input)
    if (root) keep.add(root)
  }

  let stopped = 0
  for (const [root, project] of watchedRoots()) {
    if (keep.has(root)) continue
    unwatchProject(root, input.log)
    reported.delete(project)
    stopped++
  }

  input.log(
    `[project-watch] set applied: ${keep.size} watching, ${input.projects.length - keep.size} skipped, ${stopped} stopped`,
  )
}

/** A disconnect drops every watch, so the next set must re-report from scratch. */
export function resetWatchSetReports(): void {
  reported.clear()
}

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

/**
 * Projects the last set asked for that are NOT being watched, keyed by resolved
 * root. This is what makes the board write path able to re-arm: a board op
 * arrives carrying a `projectRoot` and no URI, and `watchProject` needs the URI
 * to tag the events it emits. The set is the only place both are known
 * together, so it remembers them for exactly the projects that might need it.
 */
const skipped = new Map<string, { project: string; leaseMs: number; send: SendFn; log: LogFn }>()

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
    skipped.set(root, { project, leaseMs: input.leaseMs, send: input.send, log: input.log })
    skip(project, 'no-board', undefined, input)
    return null
  }

  try {
    watchProject(root, project, input.leaseMs, input.send, input.log)
  } catch (err) {
    skip(project, 'error', String(err), input)
    return null
  }
  skipped.delete(root)
  report(project, 'ok', input.send, { type: 'project_watch_status', project, ok: true })
  return root
}

/**
 * A board write just landed on `root` -- arm it NOW if it was skipped.
 *
 * Called from the three sentinel handlers that write a board (`project_board_op`,
 * `project_write_file`, `project_move_file`). Between them they carry EVERY
 * structured card write in the system: the panel's Kanban UI, the MCP
 * `project_set_status` tool, and the board editor all funnel through here. So
 * creating the first card in a project arms its watch on the same message that
 * created it, instead of up to one 7-minute heartbeat later -- and the move that
 * card makes next is recorded rather than lost to the gap.
 *
 * A raw `Write`/`Edit`/shell write to a card path does NOT come through here and
 * is deliberately not chased: it costs at most one heartbeat of latency, in a
 * project that is in the interest set already (an agent working there IS a
 * conversation), so it self-heals. Chasing it would mean a tool-hook path from
 * the agent host for a bounded, self-correcting delay.
 *
 * No-op unless the root was skipped: a watched project needs nothing, and a
 * project the broker never asked for has no URI here to arm it with.
 */
export function rearmAfterBoardWrite(root: string): void {
  const pending = skipped.get(root)
  if (!pending) return
  if (!existsSync(join(root, '.rclaude', 'project'))) return // a write that made no board

  try {
    watchProject(root, pending.project, pending.leaseMs, pending.send, pending.log)
  } catch (err) {
    pending.log(`[project-watch] re-arm after board write FAILED for ${pending.project}: ${String(err)}`)
    return
  }
  skipped.delete(root)
  pending.log(`[project-watch] armed ${pending.project} on its first board write (was: no-board)`)
  report(pending.project, 'ok', pending.send, { type: 'project_watch_status', project: pending.project, ok: true })
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

  // A project that left the set entirely stops being a re-arm candidate too --
  // otherwise a board write to a project the broker no longer wants would arm a
  // watch nobody asked for.
  const wanted = new Set(input.projects)
  for (const [root, pending] of skipped) if (!wanted.has(pending.project)) skipped.delete(root)

  input.log(
    `[project-watch] set applied: ${keep.size} watching, ${input.projects.length - keep.size} skipped, ${stopped} stopped`,
  )
}

/** A disconnect drops every watch, so the next set must re-report from scratch.
 *  The re-arm candidates go with it: their `send` closes over the dead socket. */
export function resetWatchSetReports(): void {
  reported.clear()
  skipped.clear()
}

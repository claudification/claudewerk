/**
 * Sentinel project-board watcher -- LEASE MODEL.
 *
 * The broker owns the truth of who's watching. It sends `project_watch` to
 * start/renew a watch (idempotent, re-stamps the lease) while >=1 dashboard
 * has a project open, and `project_unwatch` when the last viewer leaves. The
 * lease is the FAILSAFE: if the broker dies without unwatching, the watch
 * self-expires so the sentinel never leaks chokidar watchers.
 *
 * Watches live only in this process's memory. On WS reconnect the broker
 * re-arms every open project, so `stopAllWatches()` on disconnect is safe.
 *
 * Emits `project_changed { projectRoot, diff, notes }` (no conversationId) --
 * the broker broadcasts it permission-gated by the project URI.
 */

import { join } from 'node:path'
import { type TreeWatcher, watchTree } from '../shared/fs-watch'
import { CARDS_DIR, listProjectManifest, listProjectTasks } from '../shared/project-store'
import type { ProjectTaskManifestEntry } from '../shared/project-task-types'
import type { ProjectChanged, ProjectDiff } from '../shared/protocol'
import { TASK_STATUS_PATTERN } from '../shared/task-statuses'

/** The card id, and nothing else. A lane change used to look like a removal
 *  plus an addition (the key carried the status); now it is one `modified`. */
type ManifestKey = string
function mkey(e: { slug: string }): ManifestKey {
  return e.slug
}

function diffManifest(prev: Map<ManifestKey, ProjectTaskManifestEntry>, next: ProjectTaskManifestEntry[]): ProjectDiff {
  const added: ProjectTaskManifestEntry[] = []
  const modified: ProjectTaskManifestEntry[] = []
  const seen = new Set<ManifestKey>()
  for (const entry of next) {
    const k = mkey(entry)
    seen.add(k)
    const prior = prev.get(k)
    if (!prior) added.push(entry)
    // A lane change bumps mtime, but never trust that alone: `status` is now
    // file CONTENT, so compare it explicitly or a same-mtime edit goes unseen.
    else if (prior.mtime !== entry.mtime || prior.status !== entry.status) modified.push(entry)
  }
  const removed: { slug: string; status: string }[] = []
  for (const [k, entry] of prev) {
    if (!seen.has(k)) removed.push({ slug: entry.slug, status: entry.status })
  }
  return { added, removed, modified }
}

/**
 * Canonical cards, plus legacy lane cards on a board that hasn't been upgraded.
 * `views/` is deliberately EXCLUDED: it is a generated symlink farm mirroring
 * the cards, so watching it would fire a second event for every single change.
 */
const PROJECT_TASK_PATTERN = new RegExp(`\\.rclaude/project/(?:${CARDS_DIR}|${TASK_STATUS_PATTERN})/[^/]+\\.md$`)

interface WatchEntry {
  /** Canonical project URI -- echoed in project_changed for broker broadcast scoping. */
  project: string
  watcher: TreeWatcher
  lastManifest: Map<ManifestKey, ProjectTaskManifestEntry>
  expiryTimer: ReturnType<typeof setTimeout>
  pollInterval: ReturnType<typeof setInterval>
}

type SendFn = (msg: ProjectChanged) => void
type LogFn = (msg: string) => void

const watches = new Map<string, WatchEntry>()

function manifestMap(root: string): Map<ManifestKey, ProjectTaskManifestEntry> {
  const m = new Map<ManifestKey, ProjectTaskManifestEntry>()
  for (const e of listProjectManifest(root)) m.set(mkey(e), e)
  return m
}

function emitIfChanged(projectRoot: string, entry: WatchEntry, send: SendFn) {
  const next = listProjectManifest(projectRoot)
  const diff = diffManifest(entry.lastManifest, next)
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) return
  const notes = listProjectTasks(projectRoot)
  send({ type: 'project_changed', project: entry.project, diff, notes })
  const map = new Map<ManifestKey, ProjectTaskManifestEntry>()
  for (const e of next) map.set(mkey(e), e)
  entry.lastManifest = map
}

/**
 * Start a new watch or renew an existing one. Idempotent: a second call for the
 * same projectRoot just re-stamps the lease (and resets the failsafe timer).
 */
export function watchProject(projectRoot: string, project: string, leaseMs: number, send: SendFn, log: LogFn): void {
  const existing = watches.get(projectRoot)
  if (existing) {
    clearTimeout(existing.expiryTimer)
    existing.expiryTimer = setTimeout(() => {
      log(`[project-watch] lease expired (no renew): ${projectRoot}`)
      unwatchProject(projectRoot, log)
    }, leaseMs)
    return
  }

  const projectDir = join(projectRoot, '.rclaude', 'project')

  const entry: WatchEntry = {
    project,
    // Assigned immediately below; watchTree's onEvent forward-refs `entry`
    // (same pattern as pollInterval's closure).
    watcher: undefined as unknown as TreeWatcher,
    lastManifest: manifestMap(projectRoot),
    expiryTimer: setTimeout(() => {
      log(`[project-watch] lease expired (no renew): ${projectRoot}`)
      unwatchProject(projectRoot, log)
    }, leaseMs),
    pollInterval: setInterval(() => emitIfChanged(projectRoot, entry, send), 5000),
  }
  // Recursive .md watch under the board dir (depth 2), filtered to `cards/`
  // plus any undrained legacy lane. The 300ms debounce replaces chokidar's
  // awaitWriteFinish + the old manual per-entry debounce; the 5s poll is the
  // floor for fs.watch drops or a board dir that does not exist yet.
  entry.watcher = watchTree({
    dir: projectDir,
    recursive: true,
    depth: 2,
    filter: abs => PROJECT_TASK_PATTERN.test(abs),
    debounceMs: 300,
    onEvent: () => emitIfChanged(projectRoot, entry, send),
  })
  watches.set(projectRoot, entry)

  log(
    `[project-watch] started: ${projectRoot} (lease ${Math.round(leaseMs / 1000)}s, tasks ${entry.lastManifest.size})`,
  )
}

/** Stop watching immediately (last viewer closed, or lease expired). */
export function unwatchProject(projectRoot: string, log: LogFn): void {
  const entry = watches.get(projectRoot)
  if (!entry) return
  clearTimeout(entry.expiryTimer)
  clearInterval(entry.pollInterval)
  entry.watcher.close()
  watches.delete(projectRoot)
  log(`[project-watch] stopped: ${projectRoot}`)
}

/** Tear down every watch (WS disconnect -- broker re-arms on reconnect). */
export function stopAllWatches(log: LogFn): void {
  const roots = Array.from(watches.keys())
  for (const root of roots) unwatchProject(root, log)
  if (roots.length) log(`[project-watch] cleared ${roots.length} watch(es) on disconnect`)
}

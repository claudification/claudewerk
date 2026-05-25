/**
 * Task & Project Watcher
 * Watches ~/.claude/tasks/ for CC task state changes and .rclaude/project/
 * for project board changes. Sends updates to the broker via WS.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import { claudeConfigDir } from '../shared/claude-config-dir'
import type { AgentHostMessage, TaskInfo, TasksUpdate } from '../shared/protocol'
import { normalizeTodoStatus } from '../shared/task-normalize'
import { TASK_STATUS_PATTERN } from '../shared/task-statuses'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'
import { listProjectManifest, listProjectTasks, type ProjectTaskManifestEntry } from './project-tasks'

type ManifestKey = string // `${status}/${slug}`
function mkey(e: { slug: string; status: string }): ManifestKey {
  return `${e.status}/${e.slug}`
}

interface ProjectDiff {
  added: ProjectTaskManifestEntry[]
  removed: { slug: string; status: string }[]
  modified: ProjectTaskManifestEntry[]
}

function diffManifest(
  prev: Map<ManifestKey, ProjectTaskManifestEntry>,
  next: ProjectTaskManifestEntry[],
): ProjectDiff {
  const added: ProjectTaskManifestEntry[] = []
  const modified: ProjectTaskManifestEntry[] = []
  const seen = new Set<ManifestKey>()
  for (const entry of next) {
    const k = mkey(entry)
    seen.add(k)
    const prior = prev.get(k)
    if (!prior) added.push(entry)
    else if (prior.mtime !== entry.mtime) modified.push(entry)
  }
  const removed: { slug: string; status: string }[] = []
  for (const [k, entry] of prev) {
    if (!seen.has(k)) removed.push({ slug: entry.slug, status: entry.status })
  }
  return { added, removed, modified }
}

export function readAndSendTasks(ctx: AgentHostContext) {
  if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) {
    debug(
      `readAndSendTasks: skipped (connected=${ctx.wsClient?.isConnected()}, ccSessionId=${ctx.claudeSessionId?.slice(0, 8)})`,
    )
    return
  }
  try {
    let tasksDir: string | null = null
    let anyDirExists = false
    for (const dir of ctx.taskCandidateDirs) {
      if (!existsSync(dir)) continue
      anyDirExists = true
      const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'))
      if (jsonFiles.length > 0) {
        tasksDir = dir
        break
      }
    }

    // No candidate task dir exists at all -- the agent host has no information
    // about CC's tasks (path heuristic miss, headless mode that doesn't write
    // to ~/.claude/tasks, or a conversation where TodoWrite hasn't fired yet).
    // Emitting `tasks_update { tasks: [] }` here would cause the broker to
    // archive any rehydrated-from-SQLite tasks (the broker treats absence as
    // deletion). Stay silent until we either find a dir or see real content.
    // The same guard intentionally does NOT block the legitimate empty case
    // where a candidate dir exists but is empty -- that's a real "no tasks"
    // signal from CC (Claude cleared them all).
    if (!anyDirExists) {
      debug('readAndSendTasks: no candidate task dir exists, suppressing empty broadcast')
      return
    }

    const files = tasksDir
      ? readdirSync(tasksDir)
          .filter(f => f.endsWith('.json'))
          .sort()
      : []

    const tasks: TaskInfo[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(tasksDir as string, file), 'utf-8')
        const task = JSON.parse(raw)
        tasks.push({
          id: String(task.id || ''),
          subject: String(task.subject || ''),
          description: task.description ? String(task.description) : undefined,
          status: normalizeTodoStatus(task.status),
          kind: 'todo',
          priority: typeof task.priority === 'number' ? task.priority : undefined,
          blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
          blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : undefined,
          owner: task.owner ? String(task.owner) : undefined,
          updatedAt: task.updatedAt || Date.now(),
        })
      } catch {
        // Skip malformed task files
      }
    }

    const json = JSON.stringify(tasks)
    if (json !== ctx.lastTasksJson) {
      ctx.lastTasksJson = json
      const msg: TasksUpdate = { type: 'tasks_update', conversationId: ctx.conversationId, tasks }
      ctx.wsClient?.send(msg)
      debug(`Tasks updated: ${tasks.length} tasks (dir: ${tasksDir?.split('/').pop()?.slice(0, 8)})`)
      ctx.diag('tasks', `Sent ${tasks.length} tasks`, { dir: tasksDir?.split('/').pop() })
    }
  } catch (err) {
    debug(`readAndSendTasks error: ${err}`)
    ctx.diag('tasks', `Read error: ${err}`, { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()) })
  }
}

export function startTaskWatching(ctx: AgentHostContext) {
  if (ctx.taskWatcher) return
  const tasksBase = join(claudeConfigDir(), 'tasks')
  const candidates = new Set<string>()
  if (ctx.claudeSessionId) candidates.add(join(tasksBase, ctx.claudeSessionId))
  candidates.add(join(tasksBase, ctx.conversationId))
  ctx.taskCandidateDirs = Array.from(candidates)

  const watchPaths = ctx.taskCandidateDirs.map(d => join(d, '*.json'))
  debug(`Task watcher dirs: ${ctx.taskCandidateDirs.map(d => d.split('/').pop()).join(', ')}`)
  ctx.taskWatcher = chokidarWatch(watchPaths, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })
  const reader = () => readAndSendTasks(ctx)
  ctx.taskWatcher.on('add', reader)
  ctx.taskWatcher.on('change', reader)
  ctx.taskWatcher.on('unlink', reader)
  const pollInterval = setInterval(reader, 5000)
  ctx.taskWatcher.on('close', () => clearInterval(pollInterval))
  ctx.diag('watch', 'Task watcher started', { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()), watchPaths })
}

/**
 * Compute the incremental diff vs the last broadcast manifest and emit
 * `project_changed { diff, notes }` ONLY when something actually changed.
 *
 * `notes` (full snapshot) is kept transitionally so unrewired callers still
 * work; new clients consume `diff`. Phase 3 of the incremental-tasks plan
 * removes `notes`. See `.claude/docs/plan-project-tasks-incremental.md`.
 */
export function sendProjectChanged(ctx: AgentHostContext) {
  if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) return
  const nextManifest = listProjectManifest(ctx.cwd)
  const diff = diffManifest(ctx.lastProjectManifest, nextManifest)
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) return

  const tasks = listProjectTasks(ctx.cwd)
  ctx.wsClient.send({
    type: 'project_changed',
    conversationId: ctx.conversationId,
    diff,
    notes: tasks,
  } as unknown as AgentHostMessage)

  const next = new Map<ManifestKey, ProjectTaskManifestEntry>()
  for (const entry of nextManifest) next.set(mkey(entry), entry)
  ctx.lastProjectManifest = next

  debug(
    `Project tasks changed: +${diff.added.length} -${diff.removed.length} ~${diff.modified.length} (total ${nextManifest.length})`,
  )
}

const PROJECT_TASK_PATTERN = new RegExp(`\\.rclaude/project/(${TASK_STATUS_PATTERN})/.+\\.md$`)

export function startProjectWatching(ctx: AgentHostContext) {
  if (ctx.projectWatcher) return
  const projectDir = join(ctx.cwd, '.rclaude', 'project')
  ctx.projectWatcher = chokidarWatch(join(projectDir, '**', '*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    depth: 2,
  })

  let projectDebounce: ReturnType<typeof setTimeout> | null = null
  function onProjectTaskChange(path: string) {
    if (!PROJECT_TASK_PATTERN.test(path)) return
    if (projectDebounce) clearTimeout(projectDebounce)
    projectDebounce = setTimeout(() => {
      projectDebounce = null
      sendProjectChanged(ctx)
    }, 300)
  }

  ctx.projectWatcher.on('add', onProjectTaskChange)
  ctx.projectWatcher.on('change', onProjectTaskChange)
  ctx.projectWatcher.on('unlink', onProjectTaskChange)

  // Belt-and-braces poll for changes chokidar missed (network FS, editor
  // atomic-rename quirks, the user editing markdown directly). The diff
  // computation inside sendProjectChanged is the dedup -- a poll with no
  // actual changes emits nothing on the wire.
  const projectPollInterval = setInterval(() => sendProjectChanged(ctx), 5000)
  ctx.projectWatcher.on('close', () => clearInterval(projectPollInterval))
  debug('Project watcher started')
}

/**
 * CC Task Watcher
 * Watches ~/.claude/tasks/ for CC task (TodoWrite) state changes and sends
 * updates to the broker via WS.
 *
 * NOTE: the project BOARD (.rclaude/project/**) watcher moved to the SENTINEL
 * (src/sentinel/project-watch.ts) -- the board is project-scoped and durable,
 * not tied to a live agent host. This file only handles CC's own todo tasks.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import { claudeConfigDir } from '../shared/claude-config-dir'
import type { TaskInfo, TasksUpdate } from '../shared/protocol'
import { normalizeTodoStatus } from '../shared/task-normalize'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'

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

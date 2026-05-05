import type React from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { FileInfo } from '@/hooks/use-file-editor'
import { recordSwitch } from '@/lib/conversation-frequency'
import type { Session } from '@/lib/types'
import type { CommandModeState, RegistryCommand } from './use-command-mode'
import type { SessionModeState } from './use-session-mode'
import type { SpawnModeState } from './use-spawn-mode'
import type { TaskModeState } from './use-task-mode'

export interface KeyHandlerCallbacks {
  onSelectConversation: (id: string) => void
  onFileSelect: (conversationId: string, path: string) => void
}

export interface KeyHandlerContext {
  itemCount: number
  activeIndex: number
  setActiveIndex: (updater: number | ((prev: number) => number)) => void
  setFilter: (value: string) => void

  isCommandMode: boolean
  isSpawnMode: boolean
  isFileMode: boolean
  isTaskMode: boolean

  command: CommandModeState
  session: SessionModeState
  file: { filteredFiles: FileInfo[] }
  spawn: SpawnModeState
  task: TaskModeState

  selectedConversationId: string | null
  onClose: () => void
}

/**
 * Build the palette's onKeyDown handler. Each key family delegates to a
 * named per-key helper; the Enter helper further dispatches by mode. The
 * dispatch table is built at call time because each handler closes over the
 * fresh `ctx` snapshot, so React's stale-state hazard is avoided without
 * needing useCallback memoization.
 */
export function createKeyHandler(ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks) {
  return function handleKeyDown(e: React.KeyboardEvent) {
    const handler = keyDispatchers[e.key]
    if (handler) handler(e, ctx, callbacks)
  }
}

type KeyDispatcher = (e: React.KeyboardEvent, ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks) => void

const keyDispatchers: Record<string, KeyDispatcher> = {
  ArrowDown: handleArrowDown,
  ArrowUp: handleArrowUp,
  Tab: handleTab,
  Enter: handleEnter,
}

function handleArrowDown(e: React.KeyboardEvent, ctx: KeyHandlerContext): void {
  e.preventDefault()
  ctx.setActiveIndex(i => Math.min(i + 1, ctx.itemCount - 1))
}

function handleArrowUp(e: React.KeyboardEvent, ctx: KeyHandlerContext): void {
  e.preventDefault()
  ctx.setActiveIndex(i => Math.max(i - 1, 0))
}

function handleTab(e: React.KeyboardEvent, ctx: KeyHandlerContext): void {
  // Tab only autocompletes in spawn mode (path completion). Other modes let
  // the browser keep its native focus-cycling behavior.
  if (!(ctx.isSpawnMode && ctx.spawn.filteredSpawnDirs.length > 0)) return
  e.preventDefault()
  const selected = ctx.spawn.filteredSpawnDirs[ctx.activeIndex]
  if (selected) {
    ctx.setFilter(`S:${ctx.spawn.spawnParentDir}${selected}/`)
    ctx.setActiveIndex(0)
  }
}

function handleEnter(e: React.KeyboardEvent, ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks): void {
  e.preventDefault()
  if (ctx.isCommandMode) submitCommand(ctx)
  else if (ctx.isSpawnMode) submitSpawn(ctx)
  else if (ctx.isFileMode) submitFile(ctx, callbacks)
  else if (ctx.isTaskMode) submitTask(ctx)
  else submitSession(ctx, callbacks)
}

function submitCommand(ctx: KeyHandlerContext): void {
  const cmd = ctx.command.filteredCommands[ctx.activeIndex]
  if (cmd) cmd.action(...ctx.command.getCommandArgs(cmd))
}

function submitSpawn(ctx: KeyHandlerContext): void {
  const spawn = ctx.spawn
  if (spawn.filteredSpawnDirs.length > 0 && !spawn.spawnPath.endsWith('/')) {
    const selected = spawn.filteredSpawnDirs[ctx.activeIndex]
    if (selected) {
      ctx.setFilter(`S:${spawn.spawnParentDir}${selected}/`)
      ctx.setActiveIndex(0)
    }
    return
  }
  if (spawn.spawnPath) {
    const cleanPath = spawn.spawnPath.endsWith('/') ? spawn.spawnPath.slice(0, -1) : spawn.spawnPath
    spawn.handleSpawn(cleanPath, spawn.canCreateDir)
  }
}

function submitFile(ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks): void {
  const file = ctx.file.filteredFiles[ctx.activeIndex]
  if (file && ctx.selectedConversationId) {
    callbacks.onFileSelect(ctx.selectedConversationId, file.path)
  }
}

function submitTask(ctx: KeyHandlerContext): void {
  const task = ctx.task.filteredTasks[ctx.activeIndex]
  if (task) {
    useConversationsStore.getState().setPendingTaskEdit({ slug: task.slug, status: task.status })
    ctx.onClose()
  }
}

function submitSession(ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks): void {
  const item = ctx.session.mergedItems[ctx.activeIndex]
  if (item?.kind === 'session') {
    selectConversationWithTracking(item.session, callbacks.onSelectConversation)
  } else if (item?.kind === 'command') {
    // session-mode merged items hold raw RegistryCommands; the type widening
    // (action: () => void in PaletteCommand) hides the args overload, but the
    // no-arg call below is exactly what session-mode's command surface
    // promises -- positional args only matter in command-mode (`>` prefix).
    const cmd = item.command as RegistryCommand
    cmd.action()
  }
}

export function selectConversationWithTracking(session: Session, onSelectConversation: (id: string) => void): void {
  recordSwitch(session.project)
  onSelectConversation(session.id)
}

import type React from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { recordSwitch } from '@/lib/conversation-frequency'
import type { Conversation } from '@/lib/types'
import type { CommandModeState, RegistryCommand } from './use-command-mode'
import type { ConversationModeState } from './use-conversation-mode'
import type { SpawnModeState } from './use-spawn-mode'
import type { TaskModeState } from './use-task-mode'
import type { ThemeModeState } from './use-theme-mode'

export interface KeyHandlerCallbacks {
  onSelectConversation: (id: string) => void
}

export interface KeyHandlerContext {
  itemCount: number
  activeIndex: number
  setActiveIndex: (updater: number | ((prev: number) => number)) => void
  setFilter: (value: string) => void

  isCommandMode: boolean
  isSpawnMode: boolean
  isTaskMode: boolean
  isThemeMode: boolean

  command: CommandModeState
  conversation: ConversationModeState
  spawn: SpawnModeState
  task: TaskModeState
  theme: ThemeModeState

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
  // Tab autocompletes in spawn mode (sentinel alias, profile name, then path).
  if (!ctx.isSpawnMode) return
  if (tryCompleteSentinel(e, ctx)) return
  if (tryCompleteProfile(e, ctx)) return
  if (ctx.spawn.filteredSpawnDirs.length > 0) {
    e.preventDefault()
    const selected = ctx.spawn.filteredSpawnDirs[ctx.activeIndex]
    if (selected) ctx.spawn.handleDirSelect(selected)
  }
}

// fallow-ignore-next-line complexity
function tryCompleteSentinel(e: React.KeyboardEvent, ctx: KeyHandlerContext): boolean {
  if (!ctx.spawn.isSentinelEntry || ctx.spawn.filteredSentinels.length === 0) return false
  e.preventDefault()
  const sel = ctx.spawn.filteredSentinels[ctx.activeIndex] || ctx.spawn.filteredSentinels[0]
  if (sel) ctx.spawn.handleSentinelSelect(sel.alias)
  return true
}

// fallow-ignore-next-line complexity
function tryCompleteProfile(e: React.KeyboardEvent, ctx: KeyHandlerContext): boolean {
  if (!ctx.spawn.isProfileEntry || ctx.spawn.filteredProfiles.length === 0) return false
  e.preventDefault()
  const sel = ctx.spawn.filteredProfiles[ctx.activeIndex] || ctx.spawn.filteredProfiles[0]
  if (sel) ctx.spawn.handleProfileSelect(sel.name)
  return true
}

function handleEnter(e: React.KeyboardEvent, ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks): void {
  e.preventDefault()
  if (ctx.isThemeMode) submitTheme(ctx)
  else if (ctx.isCommandMode) submitCommand(ctx)
  else if (ctx.isSpawnMode) submitSpawn(ctx)
  else if (ctx.isTaskMode) submitTask(ctx)
  else submitConversation(ctx, callbacks)
}

function submitTheme(ctx: KeyHandlerContext): void {
  ctx.theme.confirm(ctx.activeIndex)
  ctx.onClose()
}

function submitCommand(ctx: KeyHandlerContext): void {
  const cmd = ctx.command.filteredCommands[ctx.activeIndex]
  if (!cmd) return
  if (cmd.submenu) {
    ctx.setFilter(cmd.submenu)
    ctx.setActiveIndex(0)
  } else {
    cmd.action(...ctx.command.getCommandArgs(cmd))
  }
}

function submitSpawn(ctx: KeyHandlerContext): void {
  const spawn = ctx.spawn
  if (spawn.isSentinelEntry) {
    const sel = spawn.filteredSentinels[ctx.activeIndex] || spawn.filteredSentinels[0]
    if (sel) spawn.handleSentinelSelect(sel.alias)
    return
  }
  if (spawn.isProfileEntry) {
    const sel = spawn.filteredProfiles[ctx.activeIndex] || spawn.filteredProfiles[0]
    if (sel) spawn.handleProfileSelect(sel.name)
    return
  }
  submitSpawnPath(ctx)
}

// fallow-ignore-next-line complexity
function submitSpawnPath(ctx: KeyHandlerContext): void {
  const spawn = ctx.spawn
  if (spawn.filteredSpawnDirs.length > 0 && !spawn.spawnPath.endsWith('/')) {
    const selected = spawn.filteredSpawnDirs[ctx.activeIndex]
    if (selected) spawn.handleDirSelect(selected)
    return
  }
  if (spawn.spawnPath) {
    const cleanPath = spawn.spawnPath.endsWith('/') ? spawn.spawnPath.slice(0, -1) : spawn.spawnPath
    spawn.handleSpawn(cleanPath, spawn.canCreateDir)
  }
}

function submitTask(ctx: KeyHandlerContext): void {
  const task = ctx.task.filteredTasks[ctx.activeIndex]
  if (task) {
    useConversationsStore.getState().setPendingTaskEdit({ slug: task.slug, status: task.status })
    ctx.onClose()
  }
}

function submitConversation(ctx: KeyHandlerContext, callbacks: KeyHandlerCallbacks): void {
  const item = ctx.conversation.mergedItems[ctx.activeIndex]
  if (item?.kind === 'conversation') {
    selectConversationWithTracking(item.conversation, callbacks.onSelectConversation)
  } else if (item?.kind === 'project') {
    useConversationsStore.getState().selectProject(item.projectUri)
    ctx.onClose()
  } else if (item?.kind === 'command') {
    const cmd = item.command as RegistryCommand
    if (cmd.submenu) {
      ctx.setFilter(cmd.submenu)
      ctx.setActiveIndex(0)
    } else {
      cmd.action()
    }
  }
}

function selectConversationWithTracking(conversation: Conversation, onSelectConversation: (id: string) => void): void {
  recordSwitch(conversation.project)
  onSelectConversation(conversation.id)
}

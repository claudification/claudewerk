import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { recordSwitch } from '@/lib/conversation-frequency'
import type { Session } from '@/lib/types'
import { createKeyHandler, type KeyHandlerCallbacks } from './key-handlers'
import { derivePaletteMode } from './mode-detect'
import { useCommandMode } from './use-command-mode'
import { useFileMode } from './use-file-mode'
import { useSessionMode } from './use-session-mode'
import { useSpawnMode } from './use-spawn-mode'
import { useTaskMode } from './use-task-mode'

/**
 * Top-level command palette hook. Owns the search filter, active index, and
 * input ref. Each mode (session / command / file / spawn / task) is
 * implemented by a dedicated hook colocated in this folder; this orchestrator
 * stitches them together and produces the keyboard handler for the input.
 */
export function useCommandPalette(onClose: () => void) {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const projectSettings = useConversationsStore(state => state.projectSettings)
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)

  const switcherInitialFilter = useConversationsStore(state => state.switcherInitialFilter)
  const [filter, setFilter] = useState(switcherInitialFilter)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Apply initial filter when switcher opens with a prefilled value
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount to consume the initial filter; switcherInitialFilter read from closure at mount time
  useEffect(() => {
    if (switcherInitialFilter) {
      setFilter(switcherInitialFilter)
      useConversationsStore.getState().openSwitcherWithFilter('')
    }
  }, [])

  const { mode, isCommandMode, isFileMode, isSpawnMode, isTaskMode, isConversationMode } = derivePaletteMode(filter)

  const command = useCommandMode(filter, isCommandMode, onClose)
  const session = useSessionMode(filter, isConversationMode, command.registryCommands)
  const file = useFileMode(filter, isFileMode)
  const spawn = useSpawnMode({
    filter,
    isSpawnMode,
    sentinelConnected,
    inputRef,
    setFilter,
    setActiveIndex,
    onClose,
  })
  const task = useTaskMode(filter, isTaskMode, selectedConversationId)

  const itemCount = isCommandMode
    ? command.filteredCommands.length
    : isSpawnMode
      ? spawn.filteredSpawnDirs.length
      : isFileMode
        ? file.filteredFiles.length
        : isTaskMode
          ? task.filteredTasks.length
          : session.mergedItems.length

  // Clamp activeIndex when the result count shrinks below it
  useEffect(() => {
    if (activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, activeIndex])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent, callbacks: KeyHandlerCallbacks) {
    const dispatch = createKeyHandler(
      {
        itemCount,
        activeIndex,
        setActiveIndex,
        setFilter,
        isCommandMode,
        isSpawnMode,
        isFileMode,
        isTaskMode,
        command,
        session,
        file: { filteredFiles: file.filteredFiles },
        spawn,
        task,
        selectedConversationId,
        onClose,
      },
      callbacks,
    )
    dispatch(e)
  }

  function selectConversationWithTracking(s: Session, onSelectConversation: (id: string) => void) {
    recordSwitch(s.project)
    onSelectConversation(s.id)
  }

  return {
    // State
    filter,
    setFilter,
    activeIndex,
    setActiveIndex,
    inputRef,
    mode,

    // Store data
    sessions: session.filteredSessions,
    mergedItems: session.mergedItems,
    allConversations: session.allConversations,
    selectedConversationId,
    projectSettings,
    sentinelConnected,

    // Command mode
    filteredCommands: command.filteredCommands,

    // File mode
    filteredFiles: file.filteredFiles,
    filesLoading: file.filesLoading,

    // Spawn mode
    filteredSpawnDirs: spawn.filteredSpawnDirs,
    spawnPath: spawn.spawnPath,
    spawnParentDir: spawn.spawnParentDir,
    spawnLoading: spawn.spawnLoading,
    spawnError: spawn.spawnError,
    spawning: spawn.spawning,
    canCreateDir: spawn.canCreateDir,

    // Task mode
    filteredTasks: task.filteredTasks,
    tasksLoading: task.tasksLoading,

    // Actions
    handleKeyDown,
    handleSpawn: spawn.handleSpawn,
    handleDirSelect: spawn.handleDirSelect,
    selectConversationWithTracking,
  }
}

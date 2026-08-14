import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { CommandResults } from './command-results'
import { MergedResults } from './merged-results'
import { SpawnResults } from './spawn-results'
import { TaskResults } from './task-results'
import { ThemeResults } from './theme-results'
import type { PaletteMode } from './types'
import type { useCommandPalette } from './use-command-palette'

interface PaletteResultsProps {
  palette: ReturnType<typeof useCommandPalette>
  onSelect: (conversationId: string) => void
  onClose: () => void
}

/** Result list for whichever mode the filter prefix put the palette in. */
export function PaletteResults({ palette, onSelect, onClose }: PaletteResultsProps) {
  const byMode: Partial<Record<PaletteMode, () => ReactNode>> = {
    theme: () => (
      <ThemeResults
        themes={palette.themes}
        currentThemeId={useConversationsStore.getState().controlPanelPrefs.theme || 'tokyo-night'}
        activeIndex={palette.activeIndex}
        setActiveIndex={palette.setActiveIndex}
        onSelect={i => {
          palette.themeConfirm(i)
          onClose()
        }}
      />
    ),
    command: () => (
      <CommandResults
        commands={palette.filteredCommands}
        activeIndex={palette.activeIndex}
        setActiveIndex={palette.setActiveIndex}
      />
    ),
    spawn: () => (
      <SpawnResults
        dirs={palette.filteredSpawnDirs}
        sentinels={palette.filteredSentinels}
        profiles={palette.filteredProfiles}
        pools={palette.filteredPools}
        isSentinelEntry={palette.isSentinelEntry}
        isProfileEntry={palette.isProfileEntry}
        isPoolEntry={palette.isPoolEntry}
        resolvedSentinel={palette.spawnSentinel}
        resolvedProfile={palette.spawnProfile}
        resolvedPool={palette.spawnPool}
        loading={palette.spawnLoading}
        error={palette.spawnError}
        path={palette.spawnPath}
        spawning={palette.spawning}
        sentinelConnected={palette.sentinelConnected}
        canCreateDir={palette.canCreateDir}
        activeIndex={palette.activeIndex}
        setActiveIndex={palette.setActiveIndex}
        onDirSelect={palette.handleDirSelect}
        onSentinelSelect={palette.handleSentinelSelect}
        onProfileSelect={palette.handleProfileSelect}
        onPoolSelect={palette.handlePoolSelect}
        onSpawn={palette.handleSpawn}
      />
    ),
    task: () => (
      <TaskResults
        tasks={palette.filteredTasks}
        loading={palette.tasksLoading}
        activeIndex={palette.activeIndex}
        setActiveIndex={palette.setActiveIndex}
        onOpen={onClose}
      />
    ),
  }

  return byMode[palette.mode]?.() ?? <MergedResults palette={palette} onSelect={onSelect} onClose={onClose} />
}

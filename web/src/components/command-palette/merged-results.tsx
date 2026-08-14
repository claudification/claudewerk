import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { CommandRow } from './command-results'
import { ConversationRow, ProjectRow } from './conversation-results'
import { selectConversationFromPalette } from './palette-navigate'
import type { PaletteCommand } from './types'
import type { useCommandPalette } from './use-command-palette'

type Palette = ReturnType<typeof useCommandPalette>

interface MergedResultsProps {
  palette: Palette
  onSelect: (conversationId: string) => void
  onClose: () => void
}

/** No-prefix mode: conversations + projects + commands, already ranked together. */
export function MergedResults({ palette, onSelect, onClose }: MergedResultsProps) {
  if (palette.mergedItems.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">No matches</div>
  }

  return palette.mergedItems.map<ReactNode>((item, i) =>
    item.kind === 'conversation' ? (
      <ConversationRow
        key={`s:${item.conversation.id}`}
        conversation={item.conversation}
        selectedConversationId={palette.selectedConversationId}
        projectSettings={palette.projectSettings}
        active={i === palette.activeIndex}
        onSelect={() => {
          const sess = useConversationsStore.getState().conversationsById[item.conversation.id]
          if (sess) selectConversationFromPalette(sess, onSelect)
          else onSelect(item.conversation.id)
        }}
        onMouseEnter={() => palette.setActiveIndex(i)}
      />
    ) : item.kind === 'project' ? (
      <ProjectRow
        key={`p:${item.projectUri}`}
        projectUri={item.projectUri}
        projectSettings={palette.projectSettings}
        active={i === palette.activeIndex}
        onSelect={() => {
          useConversationsStore.getState().selectProject(item.projectUri)
          onClose()
        }}
        onMouseEnter={() => palette.setActiveIndex(i)}
      />
    ) : (
      <MergedCommandRow key={`c:${item.command.id}`} command={item.command} index={i} palette={palette} />
    ),
  )
}

/**
 * A command surfaced in the no-prefix list. Commands carrying a `submenu`
 * don't run on click: they rewrite the filter to that prefix instead.
 */
function MergedCommandRow({ command, index, palette }: { command: PaletteCommand; index: number; palette: Palette }) {
  const submenu = (command as { submenu?: string }).submenu

  return (
    <CommandRow
      command={command}
      active={index === palette.activeIndex}
      onMouseEnter={() => palette.setActiveIndex(index)}
      onClick={
        submenu
          ? () => {
              palette.setFilter(submenu)
              palette.setActiveIndex(0)
            }
          : undefined
      }
      dim
    />
  )
}

/**
 * Recap context-menu items used in the project + pinned-project + conversation
 * context menus. Two flat items (no submenu anymore): one opens the recap config
 * modal (period + retrospect, fired off as before), the other opens the history.
 * The command palette opens the same modal via openRecapConfigDialog.
 */

import { ContextMenu } from 'radix-ui'
import { haptic } from '@/lib/utils'
import { openRecapConfigDialog } from './recap-config-trigger'
import { openRecapHistory } from './recap-history-trigger'

const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

export interface RecapMenuItemsProps {
  /** Project URI for per-project recaps, or '*' for cross-project. */
  projectUri: string
}

export function RecapMenuItems({ projectUri }: RecapMenuItemsProps) {
  const recapLabel = projectUri === '*' ? 'Recap all projects…' : 'Project recap…'
  return (
    <>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openRecapConfigDialog({ projectUri })
        }}
      >
        {recapLabel}
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openRecapHistory(projectUri === '*' ? undefined : projectUri)
        }}
      >
        View past recaps…
      </ContextMenu.Item>
    </>
  )
}

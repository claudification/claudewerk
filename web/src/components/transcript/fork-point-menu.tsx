/**
 * Right-click a transcript turn to fork the conversation at that point.
 *
 * ONE menu item, not two. "From here" and "before here" are the same cut seen
 * from two sides, and which side you keep is a choice with consequences -- it
 * belongs in the dialog next to the preview of the message you picked, not
 * hidden in the verb of a menu label you read in half a second.
 *
 * Costs the virtualized transcript nothing at render time: the conversation id is
 * read from the store at CLICK time, so this subscribes to no state and never
 * re-renders a row.
 */

import { GitFork } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { haptic } from '@/lib/utils'
import type { ForkPointSeed } from '../fork-dialog/fork-point'
import { openForkDialog } from '../fork-dialog-trigger'
import { menuContentClass, menuItemClass } from '../project-list/menu-shared'

export function ForkPointMenu({ seed, children }: { seed: ForkPointSeed | null; children: ReactNode }) {
  // No boundary means no cut. Rendering the trigger anyway would offer a "fork
  // from this point" that silently forked from HEAD.
  if (!seed) return <>{children}</>

  const onSelect = () => {
    const conversationId = useConversationsStore.getState().selectedConversationId
    if (!conversationId) return
    haptic('tap')
    openForkDialog({ conversationId, forkPoint: seed })
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          <ContextMenu.Item className={menuItemClass} onSelect={onSelect}>
            <GitFork className="size-3 mr-2 shrink-0" />
            Fork from this point...
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

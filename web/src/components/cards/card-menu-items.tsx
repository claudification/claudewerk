/**
 * THE card menu. One definition, both card renderers.
 *
 * `CardChip` and the markdown renderer's `a.file-link-card` anchor both raise
 * this through `card-menu-bus`, so there is exactly one list of verbs and it
 * cannot drift between the two the way two copies would.
 *
 * Verbs are reused from the board, never reinvented: OPEN is what left-click
 * already does, LAUNCH and RUN are the board's own two start verbs (one
 * conversation vs the whole engine -- see `project-card-verbs.ts`), and MOVE is
 * the same `moveTask` the lane arrows call.
 *
 * NOTHING that is not applicable is shown. A non-epic never gets a dead RUN, an
 * unresolved card never gets a LAUNCH that would read a card nobody has, and a
 * card from a provider that is not the project board gets only the two verbs
 * that need no board (open, copy).
 */

import { DropdownMenu } from 'radix-ui'
import { menuItemClass, menuSeparatorClass } from '@/components/project-list/menu-shared'
import { useCardLookup } from '@/hooks/use-card-lookup'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useProject } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { launchProjectCard, openProjectCard, runProjectEpic } from '../conversation-detail/project-card-verbs'
import type { CardMenuTarget } from './card-menu-bus'
import { CardMoveSub } from './card-move-sub'

/** The board is the only provider whose verbs exist yet. See the file header. */
const BOARD_PROVIDER = 'project-board'

export function CardMenuItems({ target, onDone }: { target: CardMenuTarget; onDone: () => void }) {
  const lookup = useCardLookup(target.ref)
  const conversationId = useConversationsStore(s => s.selectedConversationId)
  const { moveTask } = useProject(conversationId)

  const summary = lookup.status === 'ready' ? lookup.summary : null
  const board = target.ref.provider === BOARD_PROVIDER && summary !== null
  const id = target.ref.id

  function run(action: () => void) {
    haptic('tap')
    action()
    onDone()
  }

  return (
    <>
      <DropdownMenu.Item className={menuItemClass} onSelect={() => run(() => openProjectCard(id))}>
        OPEN
      </DropdownMenu.Item>

      {board && (
        <DropdownMenu.Item className={menuItemClass} onSelect={() => run(() => launchProjectCard(id))}>
          LAUNCH -- one conversation
        </DropdownMenu.Item>
      )}

      {/* RUN is the ENGINE, over a whole epic. A card with no children has
          nothing for it to dispatch, so it is not offered one. */}
      {board && summary.kind === 'epic' && (
        <DropdownMenu.Item className={menuItemClass} onSelect={() => run(() => runProjectEpic(id))}>
          RUN -- hand the epic to the engine
        </DropdownMenu.Item>
      )}

      {board && (
        <>
          <DropdownMenu.Separator className={menuSeparatorClass} />
          <CardMoveSub id={id} lane={summary.statusLabel} onMove={moveTask} onDone={onDone} />
        </>
      )}

      <DropdownMenu.Separator className={menuSeparatorClass} />
      <DropdownMenu.Item className={menuItemClass} onSelect={() => run(() => void navigator.clipboard.writeText(id))}>
        Copy id
      </DropdownMenu.Item>
      <DropdownMenu.Item
        className={menuItemClass}
        onSelect={() => run(() => void navigator.clipboard.writeText(target.path))}
      >
        Copy path
      </DropdownMenu.Item>
    </>
  )
}

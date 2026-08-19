/**
 * MOVE TO -- the six lanes, minus the one the card is already in.
 *
 * A lane is a `status:` frontmatter key, so moving is a one-field write and the
 * card's id and path never change. Same `moveTask` the board's lane arrows call
 * (`card-actions.tsx`); this is a second entry point to it, not a second
 * implementation of it.
 */

import { TASK_STATUSES, type TaskStatus } from '@shared/task-statuses'
import { DropdownMenu } from 'radix-ui'
import { menuContentClass, menuItemClass } from '@/components/project-list/menu-shared'
import { haptic } from '@/lib/utils'

export function CardMoveSub({
  id,
  lane,
  onMove,
  onDone,
}: {
  id: string
  /** The card's current lane, verbatim from the provider. */
  lane: string
  onMove: (id: string, to: TaskStatus) => Promise<string | false>
  onDone: () => void
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={menuItemClass}>Move to</DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className={menuContentClass}>
          {TASK_STATUSES.filter(status => status !== lane).map(status => (
            <DropdownMenu.Item
              key={status}
              className={menuItemClass}
              onSelect={() => {
                haptic('tap')
                void onMove(id, status)
                onDone()
              }}
            >
              {status}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

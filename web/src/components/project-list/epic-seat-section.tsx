/**
 * The werk-master-headed subtrees, at the top of a project group.
 *
 * Extracted rather than inlined into `project-node.tsx`, which was already 369
 * lines against a 150-line bar for a `.tsx` -- adding a third nested map to it
 * would have been propagating the rot rather than cleaning it.
 *
 * Indentation matches the spawn-lineage cluster (`pl-3`) on purpose: the panel
 * already teaches "indented one level = belongs to the row above", and a second
 * indent width for the same idea would read as a different relationship.
 */

import type { ComponentType } from 'react'
import type { Conversation } from '@/lib/types'
import { ConversationContextMenu } from './conversation-context-menu'
import type { EpicSeatGroup } from './epic-seat-group'

interface EpicSeatSectionProps {
  groups: EpicSeatGroup[]
  /** Compact or rail row, chosen by the parent's view mode. */
  RowComp: ComponentType<{ conversation: Conversation }>
  onOpenSettings: () => void
  /** True when the project has anything below this section, so the separator
   *  only appears when it actually separates two things. */
  hasFollowingRows: boolean
}

export function EpicSeatSection({ groups, RowComp, onOpenSettings, hasFollowingRows }: EpicSeatSectionProps) {
  if (groups.length === 0) return null

  return (
    <>
      {groups.map(group => (
        <div key={group.key} className="space-y-0.5">
          {group.werkMaster && (
            <ConversationContextMenu conversation={group.werkMaster} onOpenSettings={onOpenSettings}>
              <div>
                <RowComp conversation={group.werkMaster} />
              </div>
            </ConversationContextMenu>
          )}
          {group.seats.map(seat => (
            <ConversationContextMenu key={seat.id} conversation={seat} onOpenSettings={onOpenSettings}>
              {/* Headless seats render FLAT. Indenting under a head that is not
                  on screen points at nothing and reads as a rendering bug. */}
              <div className={group.werkMaster ? 'pl-3' : undefined}>
                <RowComp conversation={seat} />
              </div>
            </ConversationContextMenu>
          ))}
        </div>
      ))}
      {hasFollowingRows && (
        <div className="flex items-center gap-2 px-3 py-1">
          <span className="flex-1 h-px bg-border" />
        </div>
      )}
    </>
  )
}

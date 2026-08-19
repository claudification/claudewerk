/**
 * The floating layer that draws the card menu at the pointer.
 *
 * Same shape as `card-hover-layer`, and for the same reason: one of the two card
 * renderers is a raw anchor inside `dangerouslySetInnerHTML`, so there is no
 * React element for a Radix `ContextMenu.Trigger` to clone. Instead the menu
 * hangs off a zero-size anchor parked at the click point, and BOTH renderers
 * reach it through `card-menu-bus`.
 *
 * BLOCKING by the frozen taxonomy -- a context menu is not a managed, parkable
 * surface, so Radix's own modal behaviour is left switched on.
 *
 * Keyed by the click point so a right-click on a second card while the first
 * menu is up remounts at the new position instead of leaving the panel behind.
 */

import { DropdownMenu } from 'radix-ui'
import { menuContentClass } from '@/components/project-list/menu-shared'
import { closeCardMenu, useCardMenu } from './card-menu-bus'
import { CardMenuItems } from './card-menu-items'

// fallow-ignore-next-line unused-export -- mounted through lazyModule(named(...)) in app.tsx
export function CardMenuLayer() {
  const target = useCardMenu(s => s.target)
  if (!target) return null

  return (
    <DropdownMenu.Root
      key={`${target.x},${target.y},${target.ref.id}`}
      open
      onOpenChange={open => !open && closeCardMenu()}
    >
      <DropdownMenu.Trigger asChild>
        <span aria-hidden="true" style={{ position: 'fixed', left: target.x, top: target.y, width: 0, height: 0 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContentClass} align="start" sideOffset={2}>
          <CardMenuItems target={target} onDone={closeCardMenu} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

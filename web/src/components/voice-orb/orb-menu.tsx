/**
 * THE ORB'S OWN MENU -- mute, rate, voice, tone, restart, dismiss, desk.
 *
 * Before this, the orb had a bare click (which opened the desk) and two tiny
 * text buttons floating beside it, so mute and dismiss were the only things
 * reachable and nothing said so. Everything the orb can do to ITSELF lives
 * behind this one surface. The rows themselves are in orb-menu-items.tsx; this
 * file is only the two Radix roots that host them.
 *
 * TWO PRIMITIVES, ONE SET OF ROWS -- and the reason is a11y, not taste.
 * The plain click now opens the TRANSCRIPT, so this menu cannot be a
 * DropdownMenu.Trigger on the orb: a Trigger claims pointerdown AND Enter/Space,
 * so a keyboard user pressing Enter on the orb would get this menu and could
 * never reach the transcript at all. It would also stamp `aria-haspopup="menu"`
 * on a button whose click does something else -- an outright lie to a screen
 * reader.
 *   - ORB -> ContextMenu: right-click on a mouse, and Radix's own 700ms
 *     long-press timer on touch. Claims neither click nor Enter.
 *   - PANEL BUTTON -> DropdownMenu, where `aria-haspopup="menu"` is the truth.
 * Both render `MenuRows`, so the two can never drift apart.
 *
 * The speaking rate, voice and tone are here rather than only in Settings on
 * purpose: they are the knobs you want while it is talking at you, and having
 * them next to the orb makes "did that actually change anything?" answerable
 * without leaving the screen.
 */

import { MoreHorizontal } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { MenuRows } from './orb-menu-items'
import { CONTEXT_KIT, contentClass, DROPDOWN_KIT, type OrbMenuActions } from './orb-menu-kit'

export type { OrbMenuActions }

/** Wraps THE ORB. Right-click (mouse) or long-press (touch); the plain click
 *  belongs to the transcript and is never intercepted here. */
export function OrbMenu({ actions, children }: { actions: OrbMenuActions; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={contentClass}>
          <MenuRows kit={CONTEXT_KIT} actions={actions} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** The same menu from an explicit button -- the transcript header's `⋯`. This
 *  is the route that does NOT depend on the user guessing at a long press. */
export function OrbMenuButton({ actions }: { actions: OrbMenuActions }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open the orb's menu"
          className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={contentClass} side="top" align="end" sideOffset={8}>
          <MenuRows kit={DROPDOWN_KIT} actions={actions} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

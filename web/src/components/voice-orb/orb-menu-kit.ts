/**
 * The orb menu's SHARED SHAPE -- the one interface both menu primitives satisfy,
 * the two concrete kits, and the class names every row uses.
 *
 * The orb offers the same rows from two Radix roots (ContextMenu on the orb,
 * DropdownMenu on the `⋯` button); their parts have identical props for
 * everything used here but different scope generics, so `MenuKit` is the common
 * shape and the rows are written once against it. Pulled out of the JSX so both
 * the surfaces (orb-menu.tsx) and the rows (orb-menu-items.tsx) import it without
 * either owning the other.
 */

import { ContextMenu, DropdownMenu } from 'radix-ui'

export const itemClass =
  'flex items-center justify-between gap-6 px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'
export const contentClass = 'min-w-48 border border-border bg-popover rounded-md py-1 shadow-lg z-[60]'
export const labelClass = 'px-3 py-1 text-[10px] text-muted-foreground uppercase'

/** Everything the orb can do to ITSELF, handed to the menu by its host. */
export interface OrbMenuActions {
  muted: boolean
  toggleMute(): void
  reload(): void
  dismiss(): void
  openDesk(): void
}

/** The parts both primitives expose under the same names. Structurally
 *  identical for everything used here, so the rows are written once. */
export interface MenuKit {
  Item: typeof DropdownMenu.Item
  Separator: typeof DropdownMenu.Separator
  Label: typeof DropdownMenu.Label
  RadioGroup: typeof DropdownMenu.RadioGroup
  RadioItem: typeof DropdownMenu.RadioItem
  Sub: typeof DropdownMenu.Sub
  SubTrigger: typeof DropdownMenu.SubTrigger
  SubContent: typeof DropdownMenu.SubContent
  Portal: typeof DropdownMenu.Portal
}

export const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenu.Item,
  Separator: DropdownMenu.Separator,
  Label: DropdownMenu.Label,
  RadioGroup: DropdownMenu.RadioGroup,
  RadioItem: DropdownMenu.RadioItem,
  Sub: DropdownMenu.Sub,
  SubTrigger: DropdownMenu.SubTrigger,
  SubContent: DropdownMenu.SubContent,
  Portal: DropdownMenu.Portal,
}

export const CONTEXT_KIT = {
  Item: ContextMenu.Item,
  Separator: ContextMenu.Separator,
  Label: ContextMenu.Label,
  RadioGroup: ContextMenu.RadioGroup,
  RadioItem: ContextMenu.RadioItem,
  Sub: ContextMenu.Sub,
  SubTrigger: ContextMenu.SubTrigger,
  SubContent: ContextMenu.SubContent,
  Portal: ContextMenu.Portal,
} as unknown as MenuKit // same props for what is used here; the scope generics differ

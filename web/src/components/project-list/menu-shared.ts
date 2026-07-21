/**
 * Shared styling for the project-list context menus.
 *
 * One definition rather than a copy per menu file -- these menus sit next to each
 * other in the same popup surface, so a drifting class string shows up as one row
 * looking subtly different from the row above it.
 */

export const menuItemClass =
  'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

/** The popup panel itself (root content + submenu content share this). */
export const menuContentClass =
  'min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50'

export const menuSeparatorClass = 'h-px bg-border my-1'

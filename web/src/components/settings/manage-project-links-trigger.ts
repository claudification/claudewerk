/** Module-level bus for the ManageProjectLinksDialog. The component registers
 *  its handler on mount; openers route through this bus so the dialog file
 *  stays Fast-Refresh clean. */
export const _manageProjectLinksBus: {
  open: ((projectUri?: string) => void) | null
} = { open: null }

export function openManageProjectLinks(projectUri?: string): void {
  _manageProjectLinksBus.open?.(projectUri)
}

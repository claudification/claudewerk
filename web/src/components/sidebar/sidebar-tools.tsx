import { ChevronLeft, ChevronRight, Crosshair, FolderTree } from 'lucide-react'
import { openOrganizeProjects } from '@/components/organize-projects/organize-state'

const toolButton = 'p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground'

/**
 * The conversation-list header strip. One copy now -- it used to be duplicated
 * between the mobile sheet and the desktop sidebar, which is how the two drifted.
 */
export function SidebarTools({ canLocate, onCollapse }: { canLocate: boolean; onCollapse: () => void }) {
  return (
    <div className="flex items-center justify-end gap-1 px-1 pt-1 shrink-0">
      <button type="button" onClick={openOrganizeProjects} className={toolButton} title="Organize projects & groups">
        <FolderTree className="size-3.5" />
      </button>
      {canLocate && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('locate-conversation'))}
          className={toolButton}
          title="Scroll to current conversation"
        >
          <Crosshair className="size-3.5" />
        </button>
      )}
      <button type="button" onClick={onCollapse} className={toolButton} title="Close sidebar (Ctrl+B)">
        <ChevronLeft className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * The little grab-tab that brings a collapsed DESKTOP sidebar back. Lives
 * outside the `<aside>` on purpose -- the aside is `inert` while collapsed, so a
 * button inside it could not be clicked.
 */
export function SidebarExpandTab({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="hidden lg:flex absolute left-0 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-5 h-10 rounded-r-md bg-muted/80 hover:bg-muted border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
      title="Expand sidebar (Ctrl+B)"
    >
      <ChevronRight className="size-3" />
    </button>
  )
}

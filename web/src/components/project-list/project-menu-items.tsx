/**
 * The project-scoped actions shared by both project menus (normal + pinned):
 * launch, recaps, canvases, nightshift, settings, links, pin.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { ContextMenu } from 'radix-ui'
import { updateProjectSettings, useConversationsStore } from '@/hooks/use-conversations'
import { openNightshiftModal } from '@/hooks/use-nightshift-modal'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { CanvasMenuItems } from '../canvas/canvas-menu-items'
import { RecapMenuItems } from '../recap-jobs/recap-menu-items'
import { openManageProjectLinks } from '../settings/manage-project-links-trigger'
import { openSpawnDialog } from '../spawn-dialog-trigger'
import { menuItemClass } from './menu-shared'

/** The project-scoped actions both project menus share. */
export function ProjectMenuItems({ project, onOpenSettings }: { project: string; onOpenSettings: () => void }) {
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
  return (
    <>
      <ContextMenu.Item
        className={cn(menuItemClass, 'text-cyan-400')}
        onSelect={() => {
          haptic('tap')
          openSpawnDialog({ path: projectPath(project), projectUri: project })
        }}
      >
        Launch new…
      </ContextMenu.Item>
      <RecapMenuItems projectUri={project} />
      <CanvasMenuItems projectUri={project} />
      <ContextMenu.Item
        className={cn(menuItemClass, 'text-amber-400')}
        onSelect={() => {
          haptic('tap')
          openNightshiftModal(project, 'outlook')
        }}
      >
        Nightshift…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          onOpenSettings()
        }}
      >
        Project settings…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          openManageProjectLinks(project)
        }}
      >
        Manage links…
      </ContextMenu.Item>
      <ContextMenu.Item
        className={menuItemClass}
        onSelect={() => {
          haptic('tap')
          updateProjectSettings(project, { pinned: !ps?.pinned })
        }}
      >
        {ps?.pinned ? 'Unpin project' : 'Pin project'}
      </ContextMenu.Item>
    </>
  )
}

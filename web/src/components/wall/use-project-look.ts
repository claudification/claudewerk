/**
 * How a project is meant to LOOK, resolved once per project rather than per row.
 *
 * Extracted at the P2 merge (R19): A7's runs feed and P2's river feed had grown
 * the identical sixteen-line memoised cache independently, and neither
 * werk-worker could have seen the other's copy -- the two branches were open at
 * the same time. The cache is the point: `projectSettings` is a dictionary, so
 * resolving per ROW would re-derive the same label and icon for every commit in
 * a run of commits from one project.
 *
 * The returned function is stable for as long as `projectSettings` is, so a pane
 * can pass it straight into a `useMemo` dependency list.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectDisplayName } from '@/lib/utils'

export interface ProjectLook {
  projectName: string
  projectIcon?: string
  projectColor?: string
}

export function useProjectLook(): (uri: string) => ProjectLook {
  const projectSettings = useConversationsStore(s => s.projectSettings)
  return useMemo(() => {
    const cache = new Map<string, ProjectLook>()
    return (uri: string) => {
      const hit = cache.get(uri)
      if (hit) return hit
      const settings = projectSettings[projectIdentityKey(uri)]
      const look: ProjectLook = {
        projectName: projectDisplayName(uri, settings?.label),
        ...(settings?.icon ? { projectIcon: settings.icon } : {}),
        ...(settings?.color ? { projectColor: settings.color } : {}),
      }
      cache.set(uri, look)
      return look
    }
  }, [projectSettings])
}

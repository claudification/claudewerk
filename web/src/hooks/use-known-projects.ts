/**
 * Every project the panel knows about, as pickable options.
 *
 * Union of the projects that have SETTINGS (stored, pinned or not) and the
 * projects that have CONVERSATIONS. Neither alone is enough: a project you
 * configured but have no conversation in must still be fileable, and a project
 * you just spawned into has no settings row yet. Same union the command
 * palette builds for its project nodes.
 *
 * Keyed by identity so `claude://studio/x` and a differently-spelled URI for
 * the same tree collapse to one row rather than offering the user a choice
 * between two spellings of the same board.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOption } from '@/lib/cards/task-tokens'
import { projectPath } from '@/lib/types'
import { projectDisplayName } from '@/lib/utils'

export function useKnownProjects(): ProjectOption[] {
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const conversationsById = useConversationsStore(s => s.conversationsById)

  return useMemo(() => {
    const byKey = new Map<string, string>()
    for (const uri of Object.keys(projectSettings)) byKey.set(projectIdentityKey(uri), uri)
    for (const c of Object.values(conversationsById)) {
      const key = projectIdentityKey(c.project)
      if (!byKey.has(key)) byKey.set(key, c.project)
    }
    return [...byKey.values()]
      .map(uri => ({
        uri,
        name: projectDisplayName(uri, projectSettings[projectIdentityKey(uri)]?.label),
        path: projectPath(uri),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [projectSettings, conversationsById])
}

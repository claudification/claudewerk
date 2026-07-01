import { projectIdentityKey } from '@shared/project-uri'
import { Fzf } from 'fzf'
import { useMemo } from 'react'
import { type Conversation, projectPath } from '@/lib/types'
import { classifyProjectMatch, projectBasename, projectNameStrength } from './conversation-ranking'
import type { MergedItem } from './types'

type ProjectSettings = Record<string, { label?: string; pinned?: boolean }>

export interface ProjectSearchState {
  /** All pinned project URIs -- the empty-filter view still lists every one of these. */
  pinnedProjectUris: string[]
  /** Fzf-matched project NODES for the current filter, already tiered (T3 or fuzzy). */
  projectSearchResults: MergedItem[]
}

/**
 * Project-node search for the no-prefix palette. Builds the candidate set from ALL known
 * projects (settings keys, pinned or not, UNION distinct conversation projects) so a stored
 * but unpinned project surfaces as a T3 node when it has no active conversations. A project
 * that already has active conversations is represented by them (T1/T2) and its node is
 * suppressed -- except pinned projects, which keep their legacy always-visible (fuzzy) node.
 */
export function useProjectSearch(
  filter: string,
  isConversationMode: boolean,
  conversations: Conversation[],
  projectSettings: ProjectSettings,
): ProjectSearchState {
  const activeProjectKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of conversations) if (c.status !== 'ended') s.add(projectIdentityKey(c.project))
    return s
  }, [conversations])

  const pinnedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const [uri, ps] of Object.entries(projectSettings)) if (ps.pinned) s.add(projectIdentityKey(uri))
    return s
  }, [projectSettings])

  const pinnedProjectUris = useMemo(
    () =>
      Object.entries(projectSettings).flatMap(([uri, ps]) => (ps.pinned ? [uri] : [])),
    [projectSettings],
  )

  const allProjectUris = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const uri of Object.keys(projectSettings)) byKey.set(projectIdentityKey(uri), uri)
    for (const c of conversations) {
      const k = projectIdentityKey(c.project)
      if (!byKey.has(k)) byKey.set(k, c.project)
    }
    return [...byKey.values()]
  }, [projectSettings, conversations])

  const projectFzf = useMemo(
    () =>
      new Fzf(allProjectUris, {
        selector: (uri: string) => {
          const ps = projectSettings[projectIdentityKey(uri)]
          const label = ps?.label || ''
          return `${label} ${label} ${projectBasename(uri)} ${projectPath(uri)}`
        },
        casing: 'case-insensitive',
      }),
    [allProjectUris, projectSettings],
  )

  // Cyclomatic is inflated by guard `||` + optional chaining; cognitive complexity is 5.
  // fallow-ignore-next-line complexity
  const projectSearchResults = useMemo<MergedItem[]>(() => {
    if (!isConversationMode || !filter) return []
    const out: MergedItem[] = []
    for (const r of projectFzf.find(filter)) {
      const uri = r.item
      const key = projectIdentityKey(uri)
      const ranked = classifyProjectMatch({
        projStrength: projectNameStrength(filter, projectSettings[key]?.label, uri),
        hasActiveConv: activeProjectKeys.has(key),
        isPinned: pinnedKeys.has(key),
        fzfScore: r.score,
      })
      if (ranked) out.push({ kind: 'project', projectUri: uri, ...ranked, live: false })
    }
    return out
  }, [isConversationMode, filter, projectFzf, projectSettings, activeProjectKeys, pinnedKeys])

  return { pinnedProjectUris, projectSearchResults }
}

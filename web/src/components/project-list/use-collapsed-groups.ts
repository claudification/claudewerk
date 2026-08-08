import { useCallback, useState } from 'react'

const STORAGE_KEY = 'collapsed-groups'

function load(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? new Set(JSON.parse(stored)) : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Which sidebar groups are folded, persisted across reloads.
 *
 * Ids of groups that no longer exist are left in the set on purpose: they cost
 * nothing, and pruning them would mean a group briefly missing from the tree
 * (mid-load, mid-workspace-switch) silently unfolds itself.
 */
export function useCollapsedGroups() {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(load)

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      // react-doctor-disable-next-line react-doctor/client-localstorage-no-version
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
      return next
    })
  }, [])

  return { collapsedGroups, toggleGroup }
}

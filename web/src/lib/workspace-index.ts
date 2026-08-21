/**
 * THE WORKSPACE INDEX -- what the `^workspace` filter axis reads.
 *
 * Workspace membership is not a field on anything a filter can see. It lives one
 * tier up, on the project tree (`ProjectOrder.workspaceTrees`), and it is
 * many-to-many by design: `workspace-membership.ts` says out loud that the
 * reverse "the workspace of this project" lookup was deleted on purpose and must
 * not come back. So this is NOT that lookup rebuilt -- it is the FORWARD walk,
 * `projectsInWorkspace` per workspace, folded once into the shape a per-row
 * matcher can use, and it yields a LIST per project, never a single home.
 *
 * KEYED BY DISPLAY NAME, not by project URI, and that is the whole reason this
 * file exists rather than each pane calling `workspaceIdsForNode` itself. A wall
 * row carries `project` as the DISPLAY NAME -- that is what the `@` axis matches
 * and what a project chip writes into the box -- and most panes never had the
 * URI to begin with (a sheaf bar is a label, a burn bar is a label). Resolving
 * membership at the name is therefore the only seam every pane can reach, and it
 * costs one map built per project-order change instead of a walk per row.
 *
 * Two URIs whose display names collide fold into one entry, holding the union of
 * both projects' workspaces. That is the same collision `@name` already has, and
 * the same answer: the name is what the reader typed, so the name is what is
 * matched.
 */

import type { ProjectOrder } from '@shared/project-order-types'
import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectDisplayName } from '@/lib/utils'
import { projectsInWorkspace } from '@/lib/workspace-membership'

export interface WorkspaceIndex {
  /** Every workspace a project is in, by the project's DISPLAY NAME. A project
   *  in no workspace is simply absent -- absent is never a wildcard. */
  byProject: ReadonlyMap<string, readonly string[]>
  /** Every workspace NAME, in sidebar order. The `^` autocomplete's value list. */
  names: readonly string[]
}

/** One shared "nothing filed anywhere" answer, so an order-less fleet does not
 *  allocate a fresh map per render and bust every `useWallFilter` memo. */
const EMPTY_WORKSPACE_INDEX: WorkspaceIndex = { byProject: new Map(), names: [] }

/**
 * Fold a project order into the index. Pure, so the wall's proof can seed a
 * `ProjectOrder` and assert against it without mounting a store.
 *
 * @param label how to render a project URI as the name a row carries
 */
export function buildWorkspaceIndex(order: ProjectOrder, label: (uri: string) => string): WorkspaceIndex {
  const byProject = new Map<string, string[]>()
  const names: string[] = []

  for (const ws of order.workspaces ?? []) {
    // A workspace with no name would be an unreachable token, and a duplicate
    // one is already ambiguous in the sidebar -- neither is this file's problem
    // to fix, but neither belongs in a suggestion list either.
    if (ws.name && !names.includes(ws.name)) names.push(ws.name)
    for (const uri of projectsInWorkspace(order, ws.id)) {
      const key = label(uri)
      const held = byProject.get(key)
      if (held) {
        if (!held.includes(ws.name)) held.push(ws.name)
      } else byProject.set(key, [ws.name])
    }
  }

  return { byProject, names }
}

/**
 * The live index. Both `projectOrder` and `projectSettings` are stable store
 * references that change only when the sidebar does, so the returned object is
 * stable across renders and safe in a dependency list -- which matters, because
 * thirteen `useWallFilter` calls depend on it.
 */
export function useWorkspaceIndex(): WorkspaceIndex {
  const order = useConversationsStore(s => s.projectOrder)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  return useMemo(() => {
    // Absent, not empty: several pane suites mock the conversations store with a
    // hand-rolled partial state, and a fleet with no sidebar order is the same
    // answer as a fleet with no workspaces -- nothing to scope by.
    if (!order) return EMPTY_WORKSPACE_INDEX
    return buildWorkspaceIndex(order, uri => projectDisplayName(uri, projectSettings?.[projectIdentityKey(uri)]?.label))
  }, [order, projectSettings])
}

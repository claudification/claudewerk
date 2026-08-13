// Canonical project-order types -- the SINGLE source of truth shared by the
// broker (persistence, src/broker/project-order.ts) and the web control panel
// (rendering, web/src/lib/types.ts), both of which re-export these so existing
// import sites are unchanged. Defining them once stops the two layers drifting.

export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

export interface ProjectOrderProject {
  id: string // project URI (e.g. "claude:///path") or legacy "cwd:<path>" (compat)
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

/** A workspace -- each with its OWN group/project tree. The global `tree` is
 *  the "All" view; each workspace has an independent organizational structure
 *  in `workspaceTrees[wsId]`. */
export interface Workspace {
  id: string
  name: string
  color?: string
  /** Optional custom key-layer binding ('mod+shift+1', or a chord like
   *  'mod+g w'), ADDITIONAL to the positional Ctrl+N default the tab strip
   *  hands out. Absent = positional default only. */
  key?: string
}

export interface ProjectOrder {
  tree: ProjectOrderNode[]
  /** Ordered named workspaces (the sidebar tabs). Absent/empty = only "All". */
  workspaces?: Workspace[]
  /** Per-workspace group/project trees. Each workspace has its own independent
   *  organizational structure. Absent = no workspace-specific trees yet. */
  workspaceTrees?: Record<string, ProjectOrderNode[]>
  /** @deprecated -- replaced by workspaceTrees. Migrated on first normalize(). */
  assignments?: Record<string, string>
}

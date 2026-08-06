// Where does a LAUNCH go when the user did not point at a project?
//
// Both generic launch entry points (the `l` chord in use-global-commands and
// the mobile ActionFab's Launch button) used to hand-roll their own answer,
// and they disagreed: the chord fell back to `~`, the FAB to `.`, and neither
// consulted the active workspace. This is the single resolver for both.
//
// The `source` it reports is what lets the spawn dialog warn when nothing was
// resolved -- the dialog must not have to re-derive "was a project actually
// selected?" from a bare path string.
import { useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { projectsInWorkspace } from '@/lib/workspace-membership'

export type LaunchTargetSource =
  /** The selected conversation's own project. */
  | 'conversation'
  /** A project explicitly selected in the sidebar. */
  | 'project'
  /** Nothing selected, but the active workspace holds exactly one project. */
  | 'workspace-sole'
  /** No project at all -- falling back to the configured default cwd. */
  | 'default-cwd'
  /** No project and no configured default. The dialog warns loudly. */
  | 'none'

export interface LaunchTargetInput {
  /** Project URI of the currently selected conversation, if any. */
  conversationProjectUri?: string | null
  /** Project URI explicitly selected in the sidebar, if any. */
  selectedProjectUri?: string | null
  /** Active workspace, or null for the "All" view (no sole-project inference). */
  activeWorkspaceId?: string | null
  projectOrder?: ProjectOrder | null
  defaultConversationCwd?: string | null
}

export interface LaunchTarget {
  /** Launch cwd. Never empty -- falls back to `~`, which the sentinel expands. */
  path: string
  /** Resolved project URI, or undefined when none could be determined. */
  projectUri?: string
  source: LaunchTargetSource
}

/** Last-resort cwd. The sentinel expands `~` on the host that runs the spawn. */
const HOME_FALLBACK = '~'

/** A project URI is only usable as a launch target if it yields a path. */
function fromProjectUri(uri: string | null | undefined, source: LaunchTargetSource): LaunchTarget | null {
  if (!uri) return null
  const path = projectPath(uri)
  if (!path) return null
  return { path, projectUri: uri, source }
}

/**
 * Resolve where a project-less LAUNCH should go, most specific first:
 *
 *   1. the selected conversation's project
 *   2. a project selected in the sidebar
 *   3. the active workspace's ONLY project (a workspace of one has no ambiguity)
 *   4. the configured default conversation cwd (a path, not a project)
 *   5. nothing -- `~`, and the dialog says so
 *
 * Pure by design: the store-reading wrapper is `resolveLaunchTargetFromStore`.
 */
export function resolveLaunchTarget(input: LaunchTargetInput): LaunchTarget {
  const fromConversation = fromProjectUri(input.conversationProjectUri, 'conversation')
  if (fromConversation) return fromConversation

  const fromSelection = fromProjectUri(input.selectedProjectUri, 'project')
  if (fromSelection) return fromSelection

  // A workspace is a MODE, so "the workspace" is only meaningful when one is
  // actually active -- the "All" view (null) is every project and infers
  // nothing. Two or more projects is genuine ambiguity; we do NOT guess.
  if (input.activeWorkspaceId && input.projectOrder) {
    const projects = projectsInWorkspace(input.projectOrder, input.activeWorkspaceId)
    if (projects.length === 1) {
      const sole = fromProjectUri(projects[0], 'workspace-sole')
      if (sole) return sole
    }
  }

  const defaultCwd = input.defaultConversationCwd?.trim()
  if (defaultCwd) return { path: defaultCwd, source: 'default-cwd' }

  return { path: HOME_FALLBACK, source: 'none' }
}

/** Snapshot the store and resolve. The ONE thing both generic launch entry
 *  points call -- keep them from drifting apart again. */
export function resolveLaunchTargetFromStore(): LaunchTarget {
  const store = useConversationsStore.getState()
  const selected = store.selectedConversationId ? store.conversationsById[store.selectedConversationId] : undefined
  return resolveLaunchTarget({
    conversationProjectUri: selected?.project,
    selectedProjectUri: store.selectedProjectUri,
    activeWorkspaceId: store.controlPanelPrefs.activeWorkspaceId,
    projectOrder: store.projectOrder,
    defaultConversationCwd: store.controlPanelPrefs.defaultConversationCwd,
  })
}

/** True when the target carries no project -- the dialog warns on these. */
export function launchTargetNeedsWarning(source: LaunchTargetSource): boolean {
  return source === 'default-cwd' || source === 'none'
}

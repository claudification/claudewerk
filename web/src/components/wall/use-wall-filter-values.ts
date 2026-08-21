/**
 * THE REAL VALUES BEHIND EACH SIGIL -- what the filter box offers you.
 *
 * Every list here is derived from what the fleet HAS right now. Nothing is
 * hardcoded, and that is the point of the card: a static model list goes stale
 * the week a model ships, and a static project list is wrong the moment somebody
 * opens a new folder. `:` offers the models that are actually running, `&` the
 * hosts that are actually connected, `#` the branches and worktrees that
 * actually exist.
 *
 * ONE SIGIL AT A TIME. The hook takes the sigil the caret is inside and derives
 * only that list, because deriving five lists on every keystroke of a query that
 * mentions none of them is four wasted folds. With no sigil active it subscribes
 * to a frozen constant, so an idle box never re-renders when the fleet ticks.
 *
 * `@` and `^` deliberately reach past the live fleet into the sidebar's project
 * order: a project with no conversation open still has commits in P2 and card
 * moves in P3, so it is a real thing to filter by. The other three cannot --
 * a host, a tag and a model exist only as a property of a running conversation.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { pulseTag } from '@/lib/pulse/action-text'
import type { Conversation, ProjectSettingsMap } from '@/lib/types'
import { projectDisplayName } from '@/lib/utils'
import { useWorkspaceIndex, type WorkspaceIndex } from '@/lib/workspace-index'
import type { SuggestSigil } from './wall-filter-suggest'

/** Stable identity for "nothing to suggest" -- keeps the idle box out of the
 *  store's re-render path entirely. */
const NO_CONVERSATIONS: Record<string, Conversation> = {}
const NO_SETTINGS: ProjectSettingsMap = {}
const NO_VALUES: readonly string[] = []

/** Distinct, in first-seen order, blanks dropped. The store hands conversations
 *  back most-recent-first, so first-seen IS most-recently-active. */
function distinct(values: Iterable<string | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function projectNames(
  conversations: Conversation[],
  label: (uri: string) => string,
  workspaces: WorkspaceIndex,
): string[] {
  return distinct([...conversations.map(c => label(c.project)), ...workspaces.byProject.keys()])
}

/**
 * The values for one sigil, live. `sigil` is null whenever the caret is not
 * inside a completable token.
 */
export function useWallFilterValues(sigil: SuggestSigil | null): readonly string[] {
  const workspaces = useWorkspaceIndex()
  // The workspace list is the one that needs no conversation at all, so the
  // heavier subscription is skipped for it as well as for an idle box.
  const wants = sigil !== null && sigil !== '^'
  const byId = useConversationsStore(s => (wants ? s.conversationsById : NO_CONVERSATIONS))
  const projectSettings = useConversationsStore(s => (wants ? s.projectSettings : NO_SETTINGS))

  return useMemo(() => {
    if (sigil === '^') return workspaces.names
    if (!wants) return NO_VALUES
    const conversations = Object.values(byId)
    switch (sigil) {
      case '@':
        return projectNames(
          conversations,
          uri => projectDisplayName(uri, projectSettings[projectIdentityKey(uri)]?.label),
          workspaces,
        )
      case '#':
        return distinct(conversations.map(pulseTag))
      case '&':
        return distinct(conversations.map(c => c.hostSentinelAlias ?? c.hostSentinelId))
      case ':':
        return distinct(conversations.map(c => c.model))
      default:
        return NO_VALUES
    }
  }, [sigil, wants, byId, projectSettings, workspaces])
}

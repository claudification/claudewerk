import { projectIdentityKey } from '@shared/project-uri'
import { GitBranch, Pin } from 'lucide-react'
import { memo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { renderProjectIcon } from '../project-icons'
import { ProjectSettingsButton, ProjectSettingsEditor } from '../project-settings-editor'
import { ConversationContextMenu, PinnedProjectContextMenu, ProjectContextMenu } from './conversation-context-menu'
import { ConversationCard, ConversationItemCompact, SpawnRootStub } from './conversation-item'
import { InlineConfirmButton } from './inline-confirm-button'
import { groupByLineage, neededOrphanRootIds } from './lineage'
import { partitionConversations } from './partition'

function idsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function optionalIdsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0
  return idsEqual(a, b)
}

// ─── Dismiss all ended conversations button ────────────────────────────

function DismissAllEndedButton({ endedIds }: { endedIds: string[] }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  if (endedIds.length === 0) return null

  return (
    <InlineConfirmButton
      onConfirm={() => {
        for (const id of endedIds) dismissConversation(id)
      }}
      confirmLabel={<span className="text-muted-foreground">dismiss {endedIds.length}?</span>}
      trigger={requestConfirm => (
        <div
          role="button"
          tabIndex={0}
          onClick={requestConfirm}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') requestConfirm(e)
          }}
          className="text-[9px] text-muted-foreground/40 hover:text-destructive cursor-pointer px-1 transition-colors"
          title={`Dismiss ${endedIds.length} ended conversation${endedIds.length > 1 ? 's' : ''}`}
        >
          {'✕'} ended
        </div>
      )}
    />
  )
}

// ─── Multi-conversation project card ────────────────────────────────────
//
// Resolves the full Conversation list from the store using the conversationIds
// list (stable ref from the parent). Re-renders only when one of the
// referenced conversations' identity changes (because zustand's selector
// short-circuits when the resolved array is shallow-equal to the previous).
const ProjectConversationGroup = memo(
  function ProjectConversationGroup({
    conversationIds,
    project,
    crossProjectStubIds,
  }: {
    conversationIds: string[]
    project: string
    /** Lineage roots whose chains include a member living in THIS project but
     *  rooted in a different project. Each id renders as a dimmed
     *  `SpawnRootStub` at the top of the group, linking back to the root's
     *  transcript. The lineage member itself appears nested under the root
     *  in the root's project. */
    crossProjectStubIds?: string[]
  }) {
    const [showSettings, setShowSettings] = useState(false)
    const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
    const selectProject = useConversationsStore(s => s.selectProject)
    const displayName = ps?.label || extractProjectLabel(project)
    const displayColor = ps?.color
    // Hydrate conversations from the per-id index. Conversations whose identity didn't
    // change keep the same reference -- useShallow short-circuits when none
    // of the elements changed.
    const conversations = useConversationsStore(
      useShallow(s => {
        const out: Conversation[] = []
        for (const id of conversationIds) {
          const c = s.conversationsById[id]
          if (c) out.push(c)
        }
        return out
      }),
    )
    const { worktrees, adhoc, normal, ended } = partitionConversations(conversations)
    // Project-level rollups: any conversation in this project needing attention?
    const hasPendingPermission = useConversationsStore(s => {
      const ids = new Set(conversationIds)
      return s.pendingPermissions.some(p => ids.has(p.conversationId))
    })
    const hasPendingLink = useConversationsStore(s => {
      const ids = new Set(conversationIds)
      return s.pendingProjectLinks.some(r => ids.has(r.fromConversation) || ids.has(r.toConversation))
    })
    const hasPendingAttention = conversations.some(s => s.pendingAttention)
    const hasNotification = conversations.some(s => s.hasNotification)

    // Spawn-lineage grouping for the normal bucket: cluster spawned children
    // under their root. Roots that ended/filtered out of this project's visible
    // set are pulled from the store as dimmed orphan roots so the chain stays
    // visible. (Walking only `normal` -- ad-hoc / worktree buckets keep their
    // own separators; daemon-spawned children land in `normal`.)
    const orphanRootIds = neededOrphanRootIds(normal)
    const orphanRoots = useConversationsStore(
      useShallow(s => {
        const out: Conversation[] = []
        for (const id of orphanRootIds) {
          const c = s.conversationsById[id]
          if (c) out.push(c)
        }
        return out
      }),
    )
    const normalGroups = groupByLineage(normal, orphanRoots)

    return (
      <div>
        <div
          className="border border-border"
          style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
        >
          <ProjectContextMenu
            project={project}
            conversations={conversations}
            onOpenSettings={() => setShowSettings(true)}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                haptic('tap')
                selectProject(project)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  haptic('tap')
                  selectProject(project)
                }
              }}
              className="flex items-center gap-1.5 p-3 pb-1 cursor-pointer hover:bg-accent/10 transition-colors"
            >
              {ps?.icon && (
                <span style={displayColor ? { color: displayColor } : undefined}>{renderProjectIcon(ps.icon)}</span>
              )}
              <span
                className="font-bold text-sm flex-1 truncate text-primary"
                style={displayColor ? { color: displayColor } : undefined}
                title={projectPath(project)}
              >
                {displayName}
              </span>
              {ps?.pinned && <Pin className="size-2.5 text-muted-foreground/30 shrink-0" />}
              <span className="text-[10px] text-muted-foreground font-mono">{conversations.length} conversations</span>
              {hasPendingLink && (
                <span
                  className="text-[9px] text-teal-400 font-bold animate-pulse"
                  title="A conversation in this project has a pending link request"
                >
                  LINK
                </span>
              )}
              {hasPendingPermission && (
                <span
                  className="text-[9px] text-amber-400 font-bold animate-pulse"
                  title="A conversation in this project has a pending permission request"
                >
                  PERM
                </span>
              )}
              {hasPendingAttention && !hasPendingPermission && (
                <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
              )}
              {hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
              {ended.length > 0 && <DismissAllEndedButton endedIds={ended.map(s => s.id)} />}
              <ProjectSettingsButton
                onClick={e => {
                  e.stopPropagation()
                  setShowSettings(!showSettings)
                }}
              />
            </div>
          </ProjectContextMenu>
          <div className="space-y-0.5 pb-1">
            {crossProjectStubIds && crossProjectStubIds.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 py-1">
                  <span className="flex-1 h-px bg-border" />
                  <span
                    className="text-[9px] text-muted-foreground/40 uppercase tracking-wider"
                    title="A conversation in this project was spawned from a different project. Click to jump to the spawn root."
                  >
                    spawned from elsewhere
                  </span>
                  <span className="flex-1 h-px bg-border" />
                </div>
                {crossProjectStubIds.map(rootId => (
                  <SpawnRootStub key={`xproj-${rootId}`} conversationId={rootId} />
                ))}
              </>
            )}
            {normalGroups.map(group => (
              <div key={group.key} className={group.members.length > 1 ? 'space-y-0.5' : undefined}>
                {group.members.map(member =>
                  member.orphanRoot ? (
                    <SpawnRootStub key={member.conversation.id} conversationId={member.conversation.id} />
                  ) : (
                    <ConversationContextMenu
                      key={member.conversation.id}
                      conversation={member.conversation}
                      onOpenSettings={() => setShowSettings(true)}
                    >
                      <div className={member.role === 'child' ? 'pl-3' : undefined}>
                        <ConversationItemCompact conversation={member.conversation} />
                      </div>
                    </ConversationContextMenu>
                  ),
                )}
              </div>
            ))}
            {adhoc.length > 0 && normal.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1">
                <span className="flex-1 h-px bg-border" />
                <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">ad-hoc</span>
                <span className="flex-1 h-px bg-border" />
              </div>
            )}
            {adhoc.map(conversation => (
              <ConversationContextMenu
                key={conversation.id}
                conversation={conversation}
                onOpenSettings={() => setShowSettings(true)}
              >
                <div>
                  <ConversationItemCompact conversation={conversation} />
                </div>
              </ConversationContextMenu>
            ))}
            {worktrees.length > 0 && (normal.length > 0 || adhoc.length > 0) && (
              <div className="flex items-center gap-2 px-3 py-1">
                <span className="flex-1 h-px bg-border" />
                <GitBranch className="size-2.5 text-muted-foreground/40" />
                <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">worktrees</span>
                <span className="flex-1 h-px bg-border" />
              </div>
            )}
            {worktrees.length > 0 &&
              worktrees.map(conversation => (
                <ConversationContextMenu
                  key={conversation.id}
                  conversation={conversation}
                  onOpenSettings={() => setShowSettings(true)}
                >
                  <div>
                    <ConversationItemCompact conversation={conversation} />
                  </div>
                </ConversationContextMenu>
              ))}
          </div>
        </div>
        {showSettings && <ProjectSettingsEditor project={project} onClose={() => setShowSettings(false)} />}
      </div>
    )
  },
  (prev, next) =>
    prev.project === next.project &&
    idsEqual(prev.conversationIds, next.conversationIds) &&
    optionalIdsEqual(prev.crossProjectStubIds, next.crossProjectStubIds),
)

// ─── Pinned project node (no active conversations) ────────────────

export function PinnedProjectNode({ project }: { project: string }) {
  const [showSettings, setShowSettings] = useState(false)
  const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
  const selectProject = useConversationsStore(s => s.selectProject)
  const isSelected = useConversationsStore(s => s.selectedProjectUri === project)
  const displayName = ps?.label || extractProjectLabel(project)
  const displayColor = ps?.color

  return (
    <PinnedProjectContextMenu project={project} onOpenSettings={() => setShowSettings(true)}>
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            haptic('tap')
            selectProject(project)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              selectProject(project)
            }
          }}
          className={cn(
            'border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer',
            isSelected && 'border-primary bg-accent/10',
          )}
          style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
          title={projectPath(project)}
        >
          <div className="flex items-center gap-1.5">
            {ps?.icon && (
              <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
                {renderProjectIcon(ps.icon)}
              </span>
            )}
            <span
              className="font-mono text-xs truncate flex-1"
              style={displayColor ? { color: displayColor } : undefined}
            >
              {displayName}
            </span>
            <Pin className="size-2.5 text-muted-foreground/30 shrink-0" />
          </div>
        </div>
        {showSettings && <ProjectSettingsEditor project={project} onClose={() => setShowSettings(false)} />}
      </div>
    </PinnedProjectContextMenu>
  )
}

// ─── Single-conversation card subscribed by id ───────────────────────────

const ConversationCardById = memo(function ConversationCardById({ conversationId }: { conversationId: string }) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  if (!conversation) return null
  return <ConversationCard conversation={conversation} />
})

// ─── Project node renderer (single or multi-conversation) ─────────────

export const ProjectNode = memo(
  function ProjectNode({
    project,
    conversationIds,
    crossProjectStubIds,
  }: {
    project: string
    conversationIds: string[]
    crossProjectStubIds?: string[]
  }) {
    const isPinned = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)]?.pinned)
    // Stubs force the group rendering even for a single native conversation --
    // the user needs to see the cross-project pointer alongside, which the
    // single-card path doesn't expose.
    if (conversationIds.length === 1 && (!crossProjectStubIds || crossProjectStubIds.length === 0)) {
      return (
        <div className="relative">
          <ConversationCardById conversationId={conversationIds[0]} />
          {isPinned && <Pin className="absolute top-2 right-8 size-2.5 text-muted-foreground/25" />}
        </div>
      )
    }
    return (
      <ProjectConversationGroup
        conversationIds={conversationIds}
        project={project}
        crossProjectStubIds={crossProjectStubIds}
      />
    )
  },
  (prev, next) =>
    prev.project === next.project &&
    idsEqual(prev.conversationIds, next.conversationIds) &&
    optionalIdsEqual(prev.crossProjectStubIds, next.crossProjectStubIds),
)

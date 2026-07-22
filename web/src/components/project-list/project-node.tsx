import { projectIdentityKey } from '@shared/project-uri'
import { GitBranch, Pin } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { tallyListRender } from '@/lib/perf-metrics'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { ProjectChecklist } from '../checklist/project-checklist'
import { ProjectIcon } from '../project-icons'
import { ProjectSettingsButton } from '../project-settings-button'
import { ProjectSettingsEditor } from '../project-settings-editor-lazy'
import { ConversationContextMenu } from './conversation-context-menu'
import { ConversationItemCompact, SpawnRootStub } from './conversation-item'
import { ConversationItemRail } from './conversation-item-rail'
import { InlineConfirmButton } from './inline-confirm-button'
import { groupByLineage, neededOrphanRootIds } from './lineage'
import { partitionConversations } from './partition'
import { PinnedProjectContextMenu, ProjectContextMenu } from './project-context-menu'
import { useHydratedConversations } from './row-hooks'

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
        <button
          type="button"
          onClick={requestConfirm}
          className="text-[9px] text-muted-foreground/40 hover:text-destructive cursor-pointer px-1 transition-colors appearance-none bg-transparent border-0"
          title={`Dismiss ${endedIds.length} ended conversation${endedIds.length > 1 ? 's' : ''}`}
        >
          {'✕'} ended
        </button>
      )}
    />
  )
}

// ─── Spawn-root stub with context menu ──────────────────────────────────
//
// A spawn root pulled in as a dimmed orphan (ended / cross-project) is the ONE
// row in a lineage group that HAS children -- i.e. the exact conversation the
// "Terminate full lineage" action targets. The bare SpawnRootStub renders no
// context menu, so that action (plus Revive/Dismiss/Rename on an ended root)
// was unreachable: right-clicking an ended spawn root produced nothing. Wrap
// the stub so the menu works on these rows too.
function SpawnRootStubWithMenu({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string
  onOpenSettings?: () => void
}) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  if (!conversation) return null
  return (
    <ConversationContextMenu conversation={conversation} onOpenSettings={onOpenSettings}>
      <div>
        <SpawnRootStub conversationId={conversationId} />
      </div>
    </ConversationContextMenu>
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
    // Perf instrumentation: tally committed re-renders of this group (see the
    // ConversationItemCompact tally for the why). No-op unless perf monitor on.
    useLayoutEffect(() => {
      tallyListRender('group')
    })
    const ps = useConversationsStore(s => s.projectSettings[projectIdentityKey(project)])
    const selectProject = useConversationsStore(s => s.selectProject)
    const displayName = ps?.label || extractProjectLabel(project)
    const displayColor = ps?.color
    // Status-rail view: borderless header + a single continuous project-colored
    // spine down the rows (replaces the per-row stripe). Store subscription, so a
    // listViewMode flip re-renders this group even past the memo comparator.
    const railMode = useConversationsStore(s => s.controlPanelPrefs.listViewMode === 'rail')
    const RowComp = railMode ? ConversationItemRail : ConversationItemCompact
    // Hydrate conversations from the per-id index (shared hook -- shallow-equal
    // short-circuits when no referenced conversation's identity changed).
    const conversations = useHydratedConversations(conversationIds)
    const { worktrees, adhoc, normal, ended } = useMemo(() => partitionConversations(conversations), [conversations])
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
    const orphanRootIds = useMemo(() => neededOrphanRootIds(normal), [normal])
    const orphanRoots = useHydratedConversations(orphanRootIds)
    const normalGroups = useMemo(() => groupByLineage(normal, orphanRoots), [normal, orphanRoots])

    return (
      <div>
        <div
          className={cn(railMode ? 'border-0' : 'border border-border')}
          style={!railMode && displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
        >
          {/* group/projhead scopes the checklist's reveal-on-hover to the header
              (+ the checklist itself), NOT the whole card -- hovering a
              conversation row must not pop the empty notes block open. */}
          <div className="group/projhead">
            <ProjectContextMenu
              project={project}
              conversations={conversations}
              onOpenSettings={() => setShowSettings(true)}
            >
              {/* contains nested interactive children (settings/dismiss buttons); cannot be a native <button> */}
              {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
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
                  <span style={displayColor ? { color: displayColor } : undefined}>
                    <ProjectIcon iconId={ps.icon} />
                  </span>
                )}
                <span
                  className="font-bold text-sm flex-1 truncate text-primary"
                  style={displayColor ? { color: displayColor } : undefined}
                  title={projectPath(project)}
                >
                  {displayName}
                </span>
                {ps?.pinned && <Pin className="size-2.5 text-muted-foreground/30 shrink-0" />}
                <span className="text-[10px] text-muted-foreground font-mono">
                  {conversations.length} conversation{conversations.length === 1 ? '' : 's'}
                </span>
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
            <ProjectChecklist project={project} />
          </div>
          {/* default: -mb-px overlaps the last card's bottom border onto the
              container's bottom border so they read as one line. rail: drop the
              card borders entirely and draw ONE continuous project-colored spine
              down the rows (left border on this container). */}
          <div
            className={cn('space-y-0.5', railMode ? 'ml-2.5 border-l-2 pl-1.5' : '-mb-px')}
            style={railMode ? { borderLeftColor: displayColor || 'var(--border)' } : undefined}
          >
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
                  <SpawnRootStubWithMenu key={`xproj-${rootId}`} conversationId={rootId} />
                ))}
              </>
            )}
            {normalGroups.map(group => (
              <div key={group.key} className={group.members.length > 1 ? 'space-y-0.5' : undefined}>
                {group.members.map(member =>
                  member.orphanRoot ? (
                    <SpawnRootStubWithMenu
                      key={member.conversation.id}
                      conversationId={member.conversation.id}
                      onOpenSettings={() => setShowSettings(true)}
                    />
                  ) : (
                    <ConversationContextMenu
                      key={member.conversation.id}
                      conversation={member.conversation}
                      onOpenSettings={() => setShowSettings(true)}
                    >
                      <div className={member.role === 'child' ? 'pl-3' : undefined}>
                        <RowComp conversation={member.conversation} />
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
                  <RowComp conversation={conversation} />
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
                    <RowComp conversation={conversation} />
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
      {/* group/projhead drives the checklist's reveal-on-hover empty state. For
          a pinned node the group spans only the header button + checklist (no
          conversation list), so hovering the header is the reveal trigger. The
          checklist sits OUTSIDE the button (it has its own interactive input +
          buttons, which cannot nest inside a <button>). */}
      <div
        className={cn('group/projhead border border-border hover:border-primary', isSelected && 'border-primary')}
        style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      >
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            selectProject(project)
          }}
          className={cn(
            'p-2 pl-3 transition-colors cursor-pointer text-left w-full appearance-none bg-transparent text-inherit hover:bg-accent/10',
            isSelected && 'bg-accent/10',
          )}
          title={projectPath(project)}
        >
          <div className="flex items-center gap-1.5">
            {ps?.icon && (
              <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
                <ProjectIcon iconId={ps.icon} />
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
        </button>
        <ProjectChecklist project={project} />
        {showSettings && <ProjectSettingsEditor project={project} onClose={() => setShowSettings(false)} />}
      </div>
    </PinnedProjectContextMenu>
  )
}

// ─── Project node renderer ────────────────────────────────────────────
//
// Every project renders as a header + conversation list -- including a project
// with a single conversation. One card, always under a header.

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

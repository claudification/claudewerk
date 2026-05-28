import { projectIdentityKey } from '@shared/project-uri'
import { memo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, formatAge, haptic, projectDisplayName } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from '../project-settings-editor'
import { ConversationContextMenu } from './conversation-context-menu'
import { ConversationItemCompact } from './conversation-item-compact'
import { ConversationItemFull } from './conversation-item-full'

export { ConversationItemCompact } from './conversation-item-compact'
export { SpawnRootStub } from './conversation-item-helpers'

// ─── Conversation card with settings button ─────────────────────────────

export const ConversationCard = memo(function ConversationCard({ conversation }: { conversation: Conversation }) {
  const [showSettings, setShowSettings] = useState(false)
  const isSelected = useConversationsStore(s => s.selectedConversationId === conversation.id)
  return (
    <ConversationContextMenu conversation={conversation} onOpenSettings={() => setShowSettings(true)}>
      <div>
        <div className="relative group/card">
          <ConversationItemFull conversation={conversation} />
          <div
            className={cn(
              'absolute top-2 right-2 transition-opacity',
              isSelected ? 'opacity-100' : 'opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100',
            )}
          >
            <ProjectSettingsButton
              onClick={e => {
                e.stopPropagation()
                setShowSettings(!showSettings)
              }}
            />
          </div>
        </div>
        {showSettings && (
          <ProjectSettingsEditor project={conversation.project} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </ConversationContextMenu>
  )
})

// ─── Compact peek (used for the "selected conversation" preview inside a
// collapsed group). Subscribes to a single conversation by id so the peek
// re-renders independently of ProjectList. ──────────────────────────

export const ConversationCompactPeek = memo(function ConversationCompactPeek({
  conversationId,
}: {
  conversationId: string
}) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  if (!conversation) return null
  return <ConversationItemCompact conversation={conversation} />
})

// ─── Inactive project item ────────────────────────────────────────

export const InactiveProjectItem = memo(
  function InactiveProjectItem({ conversationIds }: { conversationIds: string[] }) {
    const [showSettings, setShowSettings] = useState(false)
    const selectConversation = useConversationsStore(s => s.selectConversation)
    const conversations = useConversationsStore(
      useShallow(s => conversationIds.map(id => s.conversationsById[id]).filter(Boolean) as Conversation[]),
    )
    const latest =
      conversations.length > 0 ? conversations.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b)) : null
    const ps = useConversationsStore(s => (latest ? s.projectSettings[projectIdentityKey(latest.project)] : undefined))
    if (!latest) return null
    const displayName = projectDisplayName(projectPath(latest.project), ps?.label)
    const displayColor = ps?.color

    return (
      <ConversationContextMenu conversation={latest} onOpenSettings={() => setShowSettings(true)}>
        <div>
          <div
            data-conversation-id={latest.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              haptic('tap')
              selectConversation(latest.id, 'click')
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                haptic('tap')
                selectConversation(latest.id, 'click')
              }
            }}
            className="w-full text-left border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer"
            style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
            title={`${conversations.length} conversation${conversations.length > 1 ? 's' : ''}\n${projectPath(latest.project)}`}
          >
            <div className="flex items-center gap-1.5">
              {ps?.icon && (
                <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
                  {renderProjectIcon(ps.icon)}
                </span>
              )}
              <span
                className="font-mono text-xs text-muted-foreground truncate flex-1"
                style={displayColor ? { color: `${displayColor}99` } : undefined}
              >
                {displayName}
              </span>
              <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
                {formatAge(latest.lastActivity)}
              </span>
            </div>
          </div>
          {showSettings && <ProjectSettingsEditor project={latest.project} onClose={() => setShowSettings(false)} />}
        </div>
      </ConversationContextMenu>
    )
  },
  (prev, next) => {
    if (prev.conversationIds.length !== next.conversationIds.length) return false
    for (let i = 0; i < prev.conversationIds.length; i++) {
      if (prev.conversationIds[i] !== next.conversationIds[i]) return false
    }
    return true
  },
)

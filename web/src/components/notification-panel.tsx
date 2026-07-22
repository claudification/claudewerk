import { projectIdentityKey } from '@shared/project-uri'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AskRow, LinkRow, NotifyRow, PermissionRow, PlanApprovalRow } from '@/components/notification-items'
import { ProjectIcon } from '@/components/project-icons'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectPath } from '@/lib/types'
import { haptic, projectDisplayName } from '@/lib/utils'

interface NotificationPanelProps {
  onClose: () => void
}

interface GroupedItem {
  type: 'permission' | 'plan_approval' | 'ask' | 'link' | 'notification'
  key: string
  conversationId: string
  timestamp: number
  render: () => ReactNode
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const {
    conversationsById: conversations,
    projectSettings,
    selectConversation,
    pendingPermissions: perms,
    respondToPermission: respondPerm,
    sendPermissionRule: sendRule,
    pendingProjectLinks: links,
    respondToProjectLink: respondLink,
    pendingAskQuestions: asks,
    pendingDialogs: dialogs,
    notifications: notifs,
    dismissNotification: dismissNotif,
  } = useConversationsStore(
    useShallow(s => ({
      conversationsById: s.conversationsById,
      projectSettings: s.projectSettings,
      selectConversation: s.selectConversation,
      pendingPermissions: s.pendingPermissions,
      respondToPermission: s.respondToPermission,
      sendPermissionRule: s.sendPermissionRule,
      pendingProjectLinks: s.pendingProjectLinks,
      respondToProjectLink: s.respondToProjectLink,
      pendingAskQuestions: s.pendingAskQuestions,
      pendingDialogs: s.pendingDialogs,
      notifications: s.notifications,
      dismissNotification: s.dismissNotification,
    })),
  )

  function navigate(conversationId: string) {
    haptic('tap')
    selectConversation(conversationId, 'notification-panel')
    onClose()
  }

  // Each pending thing becomes a GroupedItem whose render() delegates to a row
  // component (see notification-items.tsx). Keeping the row JSX out of here is
  // what keeps this builder flat.
  const items: GroupedItem[] = []

  for (const p of perms) {
    items.push({
      type: 'permission',
      key: `perm-${p.requestId}`,
      conversationId: p.conversationId,
      timestamp: p.timestamp,
      render: () => <PermissionRow item={p} respondPerm={respondPerm} sendRule={sendRule} />,
    })
  }

  for (const [conversationId, dialog] of Object.entries(dialogs)) {
    if (dialog.source !== 'plan_approval') continue
    items.push({
      type: 'plan_approval',
      key: `plan-${dialog.dialogId}`,
      conversationId,
      timestamp: dialog.timestamp,
      render: () => <PlanApprovalRow conversationId={conversationId} navigate={navigate} />,
    })
  }

  for (const ask of asks) {
    items.push({
      type: 'ask',
      key: `ask-${ask.toolUseId}`,
      conversationId: ask.conversationId,
      timestamp: ask.timestamp,
      render: () => <AskRow item={ask} navigate={navigate} />,
    })
  }

  for (const link of links) {
    items.push({
      type: 'link',
      key: `link-${link.fromConversation}-${link.toConversation}`,
      conversationId: link.toConversation,
      timestamp: Date.now(),
      render: () => <LinkRow item={link} respondLink={respondLink} />,
    })
  }

  for (const n of notifs) {
    items.push({
      type: 'notification',
      key: n.id,
      conversationId: n.conversationId,
      timestamp: n.timestamp,
      render: () => <NotifyRow item={n} navigate={navigate} dismissNotif={dismissNotif} />,
    })
  }

  // Group by conversation, sort by most recent first
  const grouped = new Map<string, GroupedItem[]>()
  for (const item of items) {
    const list = grouped.get(item.conversationId) || []
    list.push(item)
    grouped.set(item.conversationId, list)
  }
  const conversationGroups = Array.from(grouped.entries()).toSorted((a, b) => {
    const aMax = Math.max(...a[1].map(i => i.timestamp))
    const bMax = Math.max(...b[1].map(i => i.timestamp))
    return bMax - aMax
  })

  if (items.length === 0) {
    return <div className="p-6 text-center text-muted-foreground text-xs">No pending notifications</div>
  }

  return (
    <div className="divide-y divide-border/50">
      {conversationGroups.map(([conversationId, groupItems]) => {
        const conversation = conversations[conversationId]
        const ps = conversation ? projectSettings[projectIdentityKey(conversation.project)] : undefined
        const displayColor = ps?.color
        const conversationName = conversation?.title || conversation?.agentName || conversationId.slice(0, 8)
        const projectName = conversation ? projectDisplayName(projectPath(conversation.project), ps?.label) : ''

        return (
          <div key={conversationId} className="p-2 space-y-1.5">
            <button
              type="button"
              className="flex items-center gap-1.5 w-full text-left hover:opacity-80 transition-opacity cursor-pointer"
              onClick={() => navigate(conversationId)}
            >
              {ps?.icon && (
                <span className="shrink-0" style={displayColor ? { color: displayColor } : undefined}>
                  <ProjectIcon iconId={ps.icon} className="size-3" />
                </span>
              )}
              {projectName && (
                <span
                  className="text-[11px] font-bold truncate"
                  style={displayColor ? { color: displayColor } : undefined}
                >
                  {projectName}
                </span>
              )}
              <span className="text-[9px] text-muted-foreground/50 truncate ml-auto">{conversationName}</span>
            </button>
            {groupItems
              .sort((a, b) => b.timestamp - a.timestamp)
              .map(item => (
                <div key={item.key}>{item.render()}</div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

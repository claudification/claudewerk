/**
 * Action FAB fan actions -- the context-aware list of buttons the mobile
 * ActionFab fans out. Split from action-fab.tsx to keep the component lean.
 */

import {
  Command,
  ListChecks,
  MessageSquarePlus,
  Orbit,
  PenLine,
  Power,
  RefreshCw,
  Rocket,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type Conversation, projectPath } from '@/lib/types'
import { useDispatchStore } from './dispatch-overlay/dispatch-store'
import { openReviveDialog } from './revive-dialog-trigger'
import { openSpawnDialog } from './spawn-dialog-trigger'
import { openTerminateConfirm } from './terminate-confirm-trigger'
import { summonVoiceOrb } from './voice-orb/voice-orb-bus'

export interface FanAction {
  id: string
  icon: React.ReactNode
  label: string
  action: () => void
  color: string
  /** Dangerous actions get extra spacing and require confirmation */
  dangerous?: boolean
}

/** The ORB, top of the fan: on mobile there is no command palette to summon it
 *  from, and talking is most of the point of a phone. Absent unless the broker
 *  actually has a realtime key, so the button can never fail at mint. */
function orbAction(): FanAction[] {
  if (useConversationsStore.getState().serverCapabilities.realtimeVoice !== true) return []
  return [
    {
      id: 'voice-orb',
      icon: <Orbit className="size-4" />,
      label: 'Orb',
      action: () => summonVoiceOrb(),
      color: 'bg-red-500',
    },
  ]
}

export function buildActions(
  conversation: Conversation | undefined,
  selectedConversationId: string | null,
): FanAction[] {
  const actions: FanAction[] = [
    ...orbAction(),
    {
      // The dispatcher is the global front desk -- the mobile counterpart to
      // the ⌘D desktop shortcut.
      id: 'dispatch',
      icon: <Sparkles className="size-4" />,
      label: 'Dispatch',
      action: () => useDispatchStore.getState().openOverlay(),
      color: 'bg-accent',
    },
    {
      id: 'switcher',
      icon: <Command className="size-4" />,
      label: 'Switcher',
      action: () => useConversationsStore.getState().toggleSwitcher(),
      color: 'bg-primary',
    },
    {
      id: 'task',
      icon: <PenLine className="size-4" />,
      label: 'Task',
      action: () => window.dispatchEvent(new Event('open-quick-task')),
      color: 'bg-active',
    },
    {
      id: 'batch-tasks',
      icon: <ListChecks className="size-4" />,
      label: 'Batch',
      action: () => window.dispatchEvent(new Event('open-batch-selector')),
      color: 'bg-info',
    },
    {
      id: 'launch',
      icon: <Rocket className="size-4" />,
      label: 'Launch',
      action: () =>
        openSpawnDialog({
          path: conversation ? projectPath(conversation.project) : '.',
          projectUri: conversation?.project,
        }),
      color: 'bg-warning',
    },
    {
      id: 'spawn',
      icon: <MessageSquarePlus className="size-4" />,
      label: 'Spawn',
      action: () => useConversationsStore.getState().openSwitcherWithFilter('S:~/'),
      color: 'bg-accent',
    },
  ]

  if (conversation && selectedConversationId) {
    if (conversation.status !== 'ended') {
      // Active conversation actions
      actions.push({
        id: 'share',
        icon: <Share2 className="size-4" />,
        label: 'Share',
        action: () => useConversationsStore.getState().openTab(selectedConversationId, 'shared'),
        color: 'bg-event-prompt',
      })
      actions.push({
        id: 'terminate',
        icon: <Power className="size-4" />,
        label: 'Terminate',
        action: () => {
          // Open the proper modal -- inline two-tap confirm was easy to miss on
          // mobile and left the action looking unresponsive. This matches the
          // ⌘K X / ⌘G X command palette path.
          const name = conversation.title || conversation.agentName || null
          openTerminateConfirm(conversation.id, name)
        },
        color: 'bg-red-500',
      })
    } else {
      // Ended conversation actions
      actions.push({
        id: 'revive',
        icon: <RefreshCw className="size-4" />,
        label: 'Revive...',
        action: () => {
          useConversationsStore.getState().selectConversation(conversation.id)
          openReviveDialog({ conversationId: conversation.id })
        },
        color: 'bg-emerald-500',
      })
      actions.push({
        id: 'dismiss',
        icon: <Trash2 className="size-4" />,
        label: 'Dismiss',
        action: () => useConversationsStore.getState().dismissConversation(conversation.id),
        color: 'bg-red-500/80',
        dangerous: true,
      })
    }
  }

  return actions
}

/**
 * Registers the conversation-scoped "Log in / re-authenticate..." command in the
 * palette. Visible only when a HEADLESS conversation is selected (cc_control is
 * unreachable on PTY/daemon). Admin is enforced broker-side on the danger
 * command, and this whole modal only mounts for admins -- same as Debug: control.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { useCommand } from '@/lib/commands'
import { openLogin } from '@/lib/open-login'

export function useLoginCommand(): void {
  useCommand(
    'conversation-login',
    () => {
      const sid = useConversationsStore.getState().selectedConversationId
      if (sid) openLogin(sid)
    },
    {
      label: 'Log in / re-authenticate...',
      group: 'Conversation',
      when: () => {
        const s = useConversationsStore.getState()
        const sid = s.selectedConversationId
        return !!sid && s.conversationsById[sid]?.transport === 'claude-headless'
      },
    },
  )
}

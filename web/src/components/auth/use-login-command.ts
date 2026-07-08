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
        if (!sid) return false
        // Hide only where cc_control definitively can't reach (PTY/daemon). A
        // missing/unresolved transport still shows it -- the broker is the true
        // gate (unsupported_transport), same as the Debug: control command.
        const transport = s.conversationsById[sid]?.transport
        return transport !== 'claude-pty' && transport !== 'claude-daemon'
      },
    },
  )
}

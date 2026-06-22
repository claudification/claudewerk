import { useConversationsStore } from '@/hooks/use-conversations'
import { DEFAULT_PERMISSIONS } from '@/lib/permissions'

/** Shared persistent-dialog test rig: a fake WS that records every sent frame
 *  into `sent`, conversation `c1` idle, and full default (interactor) perms. */
export function setupDialogConversation(sent: Array<Record<string, unknown>>): void {
  useConversationsStore.setState({
    ws: { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } as unknown as WebSocket,
    conversationsById: { c1: { id: 'c1', status: 'idle' } } as never,
    conversationPermissions: {},
    permissions: { ...DEFAULT_PERMISSIONS },
  })
}

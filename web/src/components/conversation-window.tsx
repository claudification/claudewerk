import { useEffect, useState } from 'react'
import { ConversationDetail } from '@/components/conversation-detail'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useSyncEffects } from '@/hooks/use-sync-effects'
import { useWebSocket } from '@/hooks/use-websocket'

function conversationIdFromPath(): string | null {
  const seg = window.location.pathname.split('/').filter(Boolean)
  return seg[0] === 'conversation' && seg[1] ? decodeURIComponent(seg[1]) : null
}

export function ConversationWindow() {
  const conversationId = conversationIdFromPath()
  if (!conversationId) {
    return (
      <div className="fixed inset-0 grid place-items-center text-muted-foreground text-sm">No conversation ID.</div>
    )
  }
  return <ConversationWindowInner conversationId={conversationId} />
}

// fallow-ignore-next-line complexity
function ConversationWindowInner({ conversationId }: { conversationId: string }) {
  useWebSocket()
  useSyncEffects()

  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  const isConnected = useConversationsStore(s => s.isConnected)
  const [selected, setSelected] = useState(false)

  useEffect(() => {
    if (isConnected && conversation && !selected) {
      useConversationsStore.getState().selectConversation(conversationId, 'standalone-window')
      setSelected(true)
    }
  }, [isConnected, conversation, conversationId, selected])

  const windowTitle = conversation?.title || conversation?.name || conversationId.slice(0, 12)
  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])

  if (!selected) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-background text-muted-foreground text-sm font-mono">
        {isConnected ? 'Loading conversation...' : 'Connecting...'}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <ConversationDetail conversationId={conversationId} />
    </div>
  )
}

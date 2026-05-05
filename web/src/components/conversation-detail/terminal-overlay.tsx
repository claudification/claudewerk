import { lazy, Suspense } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'

const WebTerminal = lazy(() => import('../web-terminal').then(m => ({ default: m.WebTerminal })))

interface TerminalOverlayProps {
  conversationId: string
}

export function TerminalOverlay({ conversationId }: TerminalOverlayProps) {
  return (
    <Suspense
      fallback={
        <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
          Loading terminal...
        </div>
      }
    >
      <WebTerminal
        conversationId={conversationId}
        onClose={() => {
          const store = useConversationsStore.getState()
          store.setShowTerminal(false)
          if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
        }}
      />
    </Suspense>
  )
}

import { useConversationsStore } from '@/hooks/use-conversations'

export function SyncIndicator() {
  const catching = useConversationsStore(s => s.syncCatchingUp)
  if (!catching) return null

  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[70] pointer-events-none">
      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-neutral-900/80 text-neutral-300 text-xs backdrop-blur-sm shadow-lg border border-neutral-700/50">
        <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        Syncing...
      </div>
    </div>
  )
}

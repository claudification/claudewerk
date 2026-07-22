/**
 * The chat panel's title bar: who it is connected to, minimize, disconnect.
 *
 * Split from canvas-chat-panel purely for size -- the panel crossed the 150-line
 * .tsx bar, and the header is the piece with no dependency on transcript state.
 */

import { MessageSquare, Minus, Plus, X } from 'lucide-react'

export function CanvasChatHeader({
  title,
  connected,
  minimized,
  onToggleMinimize,
  onDisconnect,
}: {
  title: string
  connected: boolean
  minimized: boolean
  onToggleMinimize: () => void
  onDisconnect: () => void
}) {
  return (
    <header className="flex items-center justify-between border-border border-b px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[10px] text-muted-foreground uppercase">{title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={minimized ? 'Expand the chat' : 'Minimize the chat'}
          onClick={onToggleMinimize}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        >
          {minimized ? <Plus className="size-3" /> : <Minus className="size-3" />}
        </button>
        {connected && (
          <button
            type="button"
            aria-label="Disconnect this canvas"
            onClick={onDisconnect}
            className="text-muted-foreground hover:text-rose-400 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <X className="size-3" />
          </button>
        )}
      </span>
    </header>
  )
}

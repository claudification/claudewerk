/**
 * The chat window that lives ON a canvas -- ORB-transcript feel, canvas chrome.
 *
 * Two states, deliberately: NOT CONNECTED is just a picker (nothing to say yet),
 * CONNECTED is a small transcript plus a box. Minimizing collapses to the header
 * so the drawing gets its space back without dropping the connection.
 *
 * A disclosure, not a dialog -- it must never trap focus, because the canvas
 * behind it is the thing being worked on.
 */

import { useState } from 'react'
import { ChatComposer, usePinToBottom } from '@/components/chat-bits/chat-bits'
import { cn } from '@/lib/utils'
import { CanvasChatHeader } from './canvas-chat-header'
import type { CanvasChat, ChatLine } from './use-canvas-chat'

function Line({ line }: { line: ChatLine }) {
  return (
    <p className={cn('text-[11px] leading-snug', line.role === 'you' ? 'text-foreground' : 'text-accent')}>
      <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">{line.who}</span>
      {line.text}
      {line.context ? <span className="ml-1.5 font-mono text-[10px] text-sky-400">[{line.context}]</span> : null}
    </p>
  )
}

/** The picker shown before a canvas is wired to anything. */
function ConnectPicker({ chat }: { chat: CanvasChat }) {
  if (chat.candidates.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-muted-foreground">No live conversations in this project.</p>
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <span className="px-1 font-mono text-[10px] text-muted-foreground uppercase">Connect to</span>
      {chat.candidates.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={() => chat.connect(c.id)}
          className="truncate rounded px-2 py-1 text-left text-[11px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        >
          {c.name}
        </button>
      ))}
    </div>
  )
}

function Transcript({ lines }: { lines: ChatLine[] }) {
  const scrollRef = usePinToBottom(lines)
  return (
    <div ref={scrollRef} className="flex max-h-48 flex-col gap-1.5 overflow-y-auto px-3 py-2">
      {lines.length === 0 ? (
        <p className="py-1 text-center text-[11px] text-muted-foreground">
          Select something and ask -- it can read and edit this canvas.
        </p>
      ) : (
        lines.map(line => <Line key={`${line.ts}-${line.role}`} line={line} />)
      )}
    </div>
  )
}

export function CanvasChatPanel({ chat }: { chat: CanvasChat }) {
  const [minimized, setMinimized] = useState(false)
  const connected = chat.connectedId !== null

  return (
    <section
      aria-label="Canvas chat"
      className="w-[min(20rem,calc(100vw-2rem))] border border-border bg-background/95 text-xs shadow-lg backdrop-blur"
    >
      <CanvasChatHeader
        title={connected ? (chat.connectedName ?? 'Chat') : 'Chat'}
        connected={connected}
        minimized={minimized}
        onToggleMinimize={() => setMinimized(m => !m)}
        onDisconnect={() => chat.connect(null)}
      />
      {!minimized && (
        <>
          {chat.error && <p className="px-3 py-1.5 text-[11px] text-rose-400">{chat.error}</p>}
          {connected ? (
            <>
              <Transcript lines={chat.lines} />
              <div className="border-border border-t p-2">
                <ChatComposer onSend={chat.send} placeholder="Ask about the selection..." />
              </div>
            </>
          ) : (
            <ConnectPicker chat={chat} />
          )}
        </>
      )}
    </section>
  )
}

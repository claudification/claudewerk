// Expanded conversation card on THE CANVAS: header (status + actions), live
// mini-transcript, and a small send box. Multiple cards can be expanded at
// once -- each rides its own WS transcript subscription.
import { ArrowUpRight, Minimize2, SendHorizontal } from 'lucide-react'
import { useState } from 'react'
import { sendInput } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import { type ConversationCardData, STATUS_ACCENT } from './canvas-types'
import { MiniTranscript } from './mini-transcript'

interface ExpandedCardProps {
  id: string
  d: ConversationCardData
  selected: boolean | undefined
  onCollapse: (id: string) => void
}

function openInDashboard(id: string) {
  window.location.hash = `conversation/${id}`
}

function HeaderBar({ id, d, onCollapse }: Omit<ExpandedCardProps, 'selected'>) {
  const accent = STATUS_ACCENT[d.status] ?? STATUS_ACCENT.idle
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', accent.pulse && 'animate-pulse')}
        style={{ backgroundColor: accent.dot }}
      />
      <span className="truncate font-mono text-xs font-semibold">{d.label}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{d.compacting ? 'compacting' : accent.label}</span>
      <div className="nodrag ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => openInDashboard(id)}
          className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          title="Open in dashboard"
        >
          <ArrowUpRight className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onCollapse(id)}
          className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          title="Collapse"
        >
          <Minimize2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function SendRow({ id }: { id: string }) {
  const [text, setText] = useState('')

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    if (sendInput(id, trimmed)) setText('')
  }

  return (
    <div className="nodrag flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit()
          e.stopPropagation()
        }}
        aria-label="Send message"
        placeholder="message…"
        className="min-w-0 flex-1 cursor-text rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-ring"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        title="Send"
      >
        <SendHorizontal className="size-3.5" />
      </button>
    </div>
  )
}

export function ExpandedCard({ id, d, selected, onCollapse }: ExpandedCardProps) {
  return (
    <div
      className={cn(
        'flex h-[520px] w-[540px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg',
        selected && 'ring-2 ring-ring',
        d.attention && 'border-warning',
      )}
    >
      <HeaderBar id={id} d={d} onCollapse={onCollapse} />
      <MiniTranscript conversationId={id} />
      {d.status !== 'ended' && <SendRow id={id} />}
    </div>
  )
}

// Live mini-transcript inside an expanded canvas card. Reads the store's
// transcript cache (populated by use-expanded; live entries stream in via the
// WS multi-subscription). `nowheel`/`nodrag` keep scrolling and text selection
// inside the card instead of zooming/panning the canvas.
import { useEffect, useMemo, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import { buildMiniRows, type MiniRow } from './transcript-snippets'

const ROLE_CLASS: Record<MiniRow['role'], string> = {
  user: 'text-foreground border-l-2 border-info pl-1.5',
  assistant: 'text-muted-foreground',
  tool: 'text-muted-foreground/60 font-mono',
  channel: 'text-warning/80',
}

export function MiniTranscript({ conversationId }: { conversationId: string }) {
  const entries = useConversationsStore(s => s.transcripts[conversationId])
  const rows = useMemo(() => buildMiniRows(entries ?? []), [entries])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow the tail unless the user scrolled up inside the card.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [rows])

  function handleScroll() {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (!entries) {
    return <div className="flex-1 px-3 py-2 text-[11px] text-muted-foreground animate-pulse">loading transcript…</div>
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="nowheel nodrag flex-1 min-h-0 cursor-auto select-text overflow-y-auto px-3 py-2 space-y-1.5"
    >
      {rows.length === 0 && <div className="text-[11px] text-muted-foreground">no messages yet</div>}
      {rows.map(row => (
        <div
          key={row.key}
          className={cn('whitespace-pre-wrap break-words text-[11px] leading-snug', ROLE_CLASS[row.role])}
        >
          <SnippetText text={row.text} />
        </div>
      ))}
    </div>
  )
}

const SNIPPET_MAX = 600

function SnippetText({ text }: { text: string }) {
  return <>{text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text}</>
}

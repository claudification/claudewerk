/**
 * The picker shown before a canvas is wired to anything: search box, then the
 * ONLINE conversations of this canvas's project, each with a status dot.
 *
 * Split out of canvas-chat-panel for size, and because "who can I talk to" is a
 * different concern from "what has been said".
 */

import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { type ChatCandidate, matchCandidates, type OnlineStatus } from './canvas-chat-candidates'
import type { CanvasChat } from './use-canvas-chat'

/** Dot colour per status -- green is working, accent is coming up or waiting. */
const DOT_CLASS: Record<OnlineStatus, string> = {
  active: 'bg-active animate-pulse',
  booting: 'bg-accent animate-pulse',
  starting: 'bg-accent animate-pulse',
  idle: 'bg-accent/50',
}

function StatusDot({ status }: { status: OnlineStatus }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[status])} />
}

function CandidateRow({ candidate, onPick }: { candidate: ChatCandidate; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={`${candidate.name} -- ${candidate.status}`}
      className="flex items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
    >
      <StatusDot status={candidate.status} />
      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
      <span className="shrink-0 font-mono text-[9px] text-muted-foreground uppercase">{candidate.status}</span>
    </button>
  )
}

function SearchBox({ value, onChange, count }: { value: string; onChange: (v: string) => void; count: number }) {
  return (
    <label className="flex items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1">
      <Search className="size-3 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`Search ${count} live...`}
        aria-label="Search live conversations"
        className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
      />
    </label>
  )
}

export function ConnectPicker({ chat }: { chat: CanvasChat }) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => matchCandidates(chat.candidates, query), [chat.candidates, query])

  if (chat.candidates.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-muted-foreground">No live conversations in this project.</p>
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <span className="px-1 font-mono text-[10px] text-muted-foreground uppercase">Connect to</span>
      <SearchBox value={query} onChange={setQuery} count={chat.candidates.length} />
      <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
        {matches.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">Nothing matches "{query.trim()}".</p>
        ) : (
          matches.map(c => <CandidateRow key={c.id} candidate={c} onPick={() => chat.connect(c.id)} />)
        )}
      </div>
    </div>
  )
}

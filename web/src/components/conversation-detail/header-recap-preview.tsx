import { useState } from 'react'
import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'

const LINE = 'text-[11px] leading-relaxed'
const TEASER_MAX = 60

/**
 * Collapsed-header summary line: recap if there is one, else the description.
 * Tap toggles between the one-line teaser and the full text.
 */
export function RecapPreview({ conversation }: { conversation: Conversation }) {
  const [expanded, setExpanded] = useState(false)
  const text = conversation.recap?.content || conversation.description
  if (!text) return null

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        setExpanded(v => !v)
      }}
      className="w-full text-left px-3 sm:px-4 pb-1.5 -mt-0.5"
    >
      {expanded ? (
        <RecapFull conversation={conversation} text={text} />
      ) : (
        <RecapTeaser conversation={conversation} text={text} />
      )}
    </button>
  )
}

function RecapTeaser({ conversation, text }: { conversation: Conversation; text: string }) {
  const teaser = conversation.recap?.title
    ? `${conversation.recap.title}...`
    : text.slice(0, TEASER_MAX).trim() + (text.length > TEASER_MAX ? '...' : '')
  return <div className={cn(LINE, 'text-muted-foreground truncate')}>{teaser}</div>
}

function RecapFull({ conversation, text }: { conversation: Conversation; text: string }) {
  return (
    <div className="space-y-0.5 pb-0.5">
      {conversation.description && conversation.recap && (
        <div className={cn(LINE, 'text-muted-foreground italic truncate')}>{conversation.description}</div>
      )}
      <div className={cn(LINE, 'whitespace-pre-wrap', bodyTone(conversation))}>
        {conversation.recap?.title && <span className="font-medium text-zinc-100">{conversation.recap.title}: </span>}
        {text}
      </div>
    </div>
  )
}

/** A fresh recap gets the accented block; a stale one plain text; no recap = the italic description. */
function bodyTone(conversation: Conversation): string {
  if (!conversation.recap) return 'text-muted-foreground italic'
  if (!conversation.recapFresh) return 'text-zinc-300'
  return 'text-zinc-200 border-l-2 border-zinc-500/60 pl-2 bg-zinc-800/20 rounded-r py-1'
}

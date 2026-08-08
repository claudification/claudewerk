import { cn } from '@/lib/utils'
import type { ArchiveHit } from './archive-api'
import { entryTypeIcon, formatProject, formatTime, PlainSnippet, SnippetText } from './bits'
import type { ConversationHit, SnippetHit } from './types'

interface RowProps {
  active: boolean
  onClick: () => void
  onHover: () => void
}

function Row({ active, onClick, onHover, children }: RowProps & { children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        'w-full px-4 py-2.5 text-left transition-colors border-b border-surface-inset/80 cursor-pointer',
        active ? 'bg-primary/12' : 'hover:bg-primary/6',
      )}
    >
      {children}
    </button>
  )
}

export function ConversationRow({ hit, ...rest }: RowProps & { hit: ConversationHit }) {
  return (
    <Row {...rest}>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-xs text-foreground font-medium truncate">{hit.title}</span>
        <span className="text-[10px] text-comment font-mono shrink-0">
          {hit.hitCount} hit{hit.hitCount > 1 ? 's' : ''}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-comment font-mono truncate max-w-[200px]">{formatProject(hit.project)}</span>
      </div>
      <div className="line-clamp-2">
        <SnippetText html={hit.bestSnippet} />
      </div>
    </Row>
  )
}

interface EntryMetaProps {
  type: string
  subtype?: string | null
  seq: number
  timestamp: number
  children?: React.ReactNode
}

/** The type/seq/time strip above a snippet, shared by hot and cold rows. */
function EntryMeta({ type, subtype, seq, timestamp, children }: EntryMetaProps) {
  return (
    <div className="flex items-center gap-2 mb-1">
      {children}
      <span className="text-[10px] text-comment font-mono">
        {entryTypeIcon(type)} {type}
        {subtype ? `/${subtype}` : ''}
      </span>
      <span className="text-[10px] text-comment">seq {seq}</span>
      <span className="flex-1" />
      <span className="text-[10px] text-comment font-mono">{formatTime(timestamp)}</span>
    </div>
  )
}

export function SnippetRow({ hit, ...rest }: RowProps & { hit: SnippetHit }) {
  return (
    <Row {...rest}>
      <EntryMeta type={hit.type} subtype={hit.subtype} seq={hit.seq} timestamp={hit.createdAt} />
      <div className="line-clamp-2">
        <SnippetText html={hit.snippet} />
      </div>
    </Row>
  )
}

/** A cold hit is labelled COLD on purpose: it came out of an archived month, so
 *  the conversation it belongs to may no longer be in the hot store at all. */
export function ArchiveRow({ hit, ...rest }: RowProps & { hit: ArchiveHit }) {
  return (
    <Row {...rest}>
      <EntryMeta type={hit.type} subtype={hit.subtype} seq={hit.seq} timestamp={hit.timestamp}>
        <span className="px-1 rounded bg-accent/15 text-accent text-[9px] font-mono shrink-0">COLD</span>
        <span className="text-[10px] text-comment font-mono">{hit.month}</span>
      </EntryMeta>
      <div className="line-clamp-3">
        <PlainSnippet text={hit.snippet} />
      </div>
    </Row>
  )
}

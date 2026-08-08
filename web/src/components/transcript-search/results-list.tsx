import type { ArchiveHit } from './archive-api'
import { EmptyState } from './bits'
import { ArchiveRow, ConversationRow, SnippetRow } from './rows'
import type { ConversationHit, SnippetHit, ViewMode } from './types'

interface ResultsListProps {
  mode: ViewMode
  query: string
  loading: boolean
  conversationHits: ConversationHit[]
  snippetHits: SnippetHit[]
  coldHits: ArchiveHit[]
  activeIndex: number
  onActivate: (index: number) => void
  onDrillInto: (conversationId: string) => void
  onGoTo: (conversationId: string) => void
}

/** Hot hits first, cold hits after, one shared index across both -- so arrow
 *  keys walk the whole list and a cold hit is never silently unreachable. */
export function ResultsList({
  mode,
  query,
  loading,
  conversationHits,
  snippetHits,
  coldHits,
  activeIndex,
  onActivate,
  onDrillInto,
  onGoTo,
}: ResultsListProps) {
  const hotHits = mode === 'snippets' ? snippetHits : conversationHits
  if (hotHits.length + coldHits.length === 0) return <EmptyState query={query} loading={loading} />

  return (
    <>
      {mode === 'conversations'
        ? conversationHits.map((hit, i) => (
            <ConversationRow
              key={hit.conversationId}
              hit={hit}
              active={i === activeIndex}
              onClick={() => onDrillInto(hit.conversationId)}
              onHover={() => onActivate(i)}
            />
          ))
        : snippetHits.map((hit, i) => (
            <SnippetRow
              key={`${hit.conversationId}-${hit.seq}`}
              hit={hit}
              active={i === activeIndex}
              onClick={() => onGoTo(hit.conversationId)}
              onHover={() => onActivate(i)}
            />
          ))}
      {coldHits.map((hit, i) => (
        <ArchiveRow
          key={`cold-${hit.conversationId}-${hit.seq}-${hit.uuid}`}
          hit={hit}
          active={hotHits.length + i === activeIndex}
          onClick={() => onGoTo(hit.conversationId)}
          onHover={() => onActivate(hotHits.length + i)}
        />
      ))}
    </>
  )
}

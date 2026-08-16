/**
 * Cell-level display helpers for the batch table. Kept apart from the row
 * components so the "what does this value look like" decisions live in one
 * place and stay testable without rendering a whole table.
 */

import type { Conversation } from '@/lib/types'

/** Base columns every layout has: select, title, status, last. */
const BASE_COLUMNS = 4

export interface ColumnSpec {
  project: boolean
  host: boolean
  recap: boolean
}

/**
 * Total rendered column count. Group headers and the empty-state row span the
 * WHOLE table, so this has to be exact -- an undercount leaves the group band
 * stopping short of the right edge (it did, for the whole life of this modal).
 */
export function columnCount(cols: ColumnSpec): number {
  return BASE_COLUMNS + (cols.project ? 1 : 0) + (cols.host ? 1 : 0) + (cols.recap ? 1 : 0)
}

/**
 * Combine sentinel + profile into a single 'host' display value.
 * `sentinel/profile` when both set; bare sentinel when no profile; null when
 * both are absent (i.e. running on the implicit default). Returning null lets
 * callers decide whether to hide the column entirely.
 */
export function hostLabel(conv: Conversation): string | null {
  const sentinel = conv.hostSentinelAlias || conv.hostSentinelId
  const profile = conv.resolvedProfile && conv.resolvedProfile !== 'default' ? conv.resolvedProfile : null
  if (!sentinel && !profile) return null
  if (sentinel && profile) return `${sentinel}/${profile}`
  return sentinel || profile
}

/** First-line snippet of a conv's recap, used by the recap column. */
export function recapSnippet(conv: Conversation): string | null {
  const content = conv.recap?.content
  if (!content) return null
  const firstLine = content.split('\n').find(l => l.trim().length > 0)
  return firstLine ? firstLine.trim() : null
}

export function StatusDot({ status }: { status: Conversation['status'] }) {
  if (status === 'active') {
    return (
      <span className="size-2 inline-block shrink-0" title="active">
        <span
          className="block size-2 rounded-full animate-spin"
          style={{ border: '1.5px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  if (status === 'ended') return <span className="text-[9px] uppercase font-bold text-muted-foreground/60">end</span>
  if (status === 'starting' || status === 'booting')
    return <span className="size-2 rounded-full shrink-0 animate-pulse" style={{ backgroundColor: 'var(--idle)' }} />
  return <span className="size-2 rounded-full shrink-0 bg-idle" title={status} />
}

export function MutedDefault({ value }: { value: string | undefined | null }) {
  if (!value || value === 'default') return <span className="text-muted-foreground/30">--</span>
  return <span>{value}</span>
}

import { cn } from '@/lib/utils'
import type { SortMode } from './types'

export function SnippetText({ html }: { html: string }) {
  const sanitized = html
    .replace(/<mark>/g, '\x01')
    .replace(/<\/mark>/g, '\x02')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\x01/g, '<mark class="bg-accent/30 text-accent rounded-sm px-0.5">')
    .replace(/\x02/g, '</mark>')

  return (
    <span
      className="text-[11px] text-foreground/70 leading-relaxed"
      // react-doctor-disable-next-line react-doctor/no-danger
      // biome-ignore lint/security/noDangerouslySetInnerHtml: pre-sanitized highlight (HTML-escaped then mark spans inserted)
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  )
}

/** Cold-archive snippets are raw text, never highlighted HTML -- they come from
 *  a grep, not from FTS5. Rendering them through SnippetText would treat their
 *  content as markup. */
export function PlainSnippet({ text }: { text: string }) {
  return <span className="text-[11px] text-foreground/70 leading-relaxed break-all">{text}</span>
}

export function formatProject(uri: string): string {
  return uri.replace(/^claude:\/\/default/, '').replace(/^\/Users\/[^/]+\//, '~/')
}

export function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const TYPE_ICONS: Record<string, string> = {
  user: '▸',
  assistant: '◂',
  tool_use: '⚙',
  tool_result: '↳',
  system: '⚑',
}

export function entryTypeIcon(type: string): string {
  return TYPE_ICONS[type] ?? '·'
}

export function SortToggle({ sort, onChange }: { sort: SortMode; onChange: (s: SortMode) => void }) {
  const opts: Array<{ value: SortMode; label: string }> = [
    { value: 'relevance', label: 'relevant' },
    { value: 'recency', label: 'recent' },
  ]
  return (
    <div className="flex items-center shrink-0 rounded bg-background border border-surface-inset overflow-hidden">
      {opts.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={sort === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-1.5 py-0.5 text-[10px] font-mono transition-colors cursor-pointer',
            sort === o.value ? 'bg-primary/15 text-primary' : 'text-comment hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SyntaxHints() {
  const hints = ['"exact phrase"', 'prefix*', 'A AND B', 'A OR B', 'A NOT B', 'NEAR(a b, 5)']
  return (
    <div className="px-4 py-3 border-t border-surface-inset bg-background">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-comment">
        {hints.map(h => (
          <span key={h}>
            <code className="text-primary">{h}</code>
          </span>
        ))}
      </div>
    </div>
  )
}

export function EmptyState({ query, loading }: { query: string; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-comment">
        <span className="text-xs animate-pulse">searching…</span>
      </div>
    )
  }
  if (query) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <span className="text-comment text-xs">no matches for "{query}"</span>
        <span className="text-[10px] text-comment">try a prefix search: {query}*</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <div className="text-comment text-2xl font-mono">/</div>
      <span className="text-comment text-xs">search across all conversations</span>
      <span className="text-[10px] text-comment">FTS5 full-text -- stemmed, ranked, fast</span>
    </div>
  )
}

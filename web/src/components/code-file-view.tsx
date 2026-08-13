/**
 * Read-only source view for the file viewer -- Shiki-highlighted, with a gutter
 * of line numbers. Non-markdown files used to land in a bare wrapped <pre>,
 * which is fine for a two-line config and unreadable for anything else.
 *
 * Line numbers are a CSS counter on `::before`, NOT DOM text: a pseudo-element
 * never enters the clipboard, so selecting the whole file still copies clean
 * code. A <span> gutter would interleave "1", "2", ... into the paste.
 */

import { type CSSProperties, useMemo } from 'react'
import { escapeHtml } from './transcript/shared'
import { langFromPath } from './transcript/syntax'
import { useBlockHighlight } from './transcript/use-block-highlight'

// Shiki tokenizes on the main thread with the JS regex engine, and the result
// is parked in a shared LRU. Past this size the pause (and the eviction of
// every transcript block) costs more than the colour is worth -- render plain.
const HIGHLIGHT_MAX_BYTES = 128 * 1024

interface CodeFileViewProps {
  content: string
  /** Project-relative path -- the only source of the language guess. */
  relPath: string
}

export function CodeFileView({ content, relPath }: CodeFileViewProps) {
  const lang = content.length <= HIGHLIGHT_MAX_BYTES ? langFromPath(relPath) : undefined
  // null until the async tokenize lands (or forever, for an unknown language):
  // the plain escaped text is the first paint and the permanent fallback.
  const html = useBlockHighlight(lang, content)
  const lines = useMemo(() => (html ?? escapeHtml(content)).split('\n'), [html, content])
  const gutterCh = `${String(lines.length).length}ch`

  return (
    <div className="overflow-x-auto text-xs">
      <div className="code-file-lines" style={{ '--code-gutter-w': gutterCh } as CSSProperties}>
        {lines.map((line, i) => (
          <div
            // Index key: lines are a positional list, and the whole array is
            // replaced wholesale when the highlight arrives.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
            key={i}
            className="code-line"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki token spans, or escapeHtml'd plain text
            dangerouslySetInnerHTML={{ __html: line }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Markdown viewer - renders a project file fetched through the sentinel.
 *
 * Mounted once at the app root; driven by the useMarkdownViewer store. A
 * relative file link in any markdown (transcript or task body), or the
 * README "FULL SCREEN" button, opens it. Slides up from the bottom and
 * covers almost the whole screen (same on mobile); Escape or the overlay /
 * close button dismisses it (Radix Dialog underneath). Read-only.
 */

import { useEffect, useState } from 'react'
import { useMarkdownViewer } from '@/hooks/use-markdown-viewer'
import { readProjectFile } from '@/hooks/use-project-tasks'
import { CodeFileView } from './code-file-view'
import { Markdown } from './markdown'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'

export function MarkdownViewerModal() {
  const current = useMarkdownViewer(s => s.current)
  const close = useMarkdownViewer(s => s.close)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (!current) return
    let cancelled = false
    setContent(null)
    setError(null)
    setTruncated(false)
    setLoading(true)
    readProjectFile(current.projectUri, current.relPath)
      .then(res => {
        if (cancelled) return
        if (res.ok) {
          setContent(res.content ?? '')
          setTruncated(!!res.truncated)
        } else {
          setError(res.error ?? 'failed to read file')
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [current])

  if (!current) return null
  const isMarkdown = /\.(md|markdown)$/i.test(current.relPath)

  return (
    <Sheet open onOpenChange={o => !o && close()}>
      <SheetContent side="bottom" className="h-[92vh] gap-0 p-4">
        <SheetTitle className="font-mono text-sm truncate pr-8 text-primary">{current.relPath}</SheetTitle>
        <div className="overflow-y-auto flex-1 min-h-0 mt-3">
          {loading && <div className="text-muted-foreground text-sm p-4">Loading…</div>}
          {error && <div className="text-destructive text-sm p-4 font-mono">Error: {error}</div>}
          {content !== null &&
            (isMarkdown ? (
              <div className="mx-auto max-w-4xl">
                <Markdown copyable>{content}</Markdown>
              </div>
            ) : (
              <CodeFileView content={content} relPath={current.relPath} />
            ))}
          {truncated && (
            <div className="text-amber-400 text-xs p-2 border-t border-border mt-2">
              File truncated (exceeds the 1 MB viewer cap).
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

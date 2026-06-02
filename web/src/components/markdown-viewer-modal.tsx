/**
 * Markdown viewer modal - renders a project file fetched through the sentinel.
 *
 * Mounted once at the app root; driven by the useMarkdownViewer store. A
 * relative file link in any markdown (transcript or task body) opens it.
 * Read-only: the Files editor was retired in favour of project-scoped,
 * sentinel-backed reads that work with no live conversation.
 */

import { useEffect, useState } from 'react'
import { useMarkdownViewer } from '@/hooks/use-markdown-viewer'
import { readProjectFile } from '@/hooks/use-project-tasks'
import { Markdown } from './markdown'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

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
    <Dialog open onOpenChange={o => !o && close()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogTitle className="font-mono text-sm truncate">{current.relPath}</DialogTitle>
        <div className="overflow-y-auto flex-1 min-h-0 mt-2">
          {loading && <div className="text-muted-foreground text-sm p-4">Loading…</div>}
          {error && <div className="text-destructive text-sm p-4 font-mono">Error: {error}</div>}
          {content !== null &&
            (isMarkdown ? (
              <Markdown copyable>{content}</Markdown>
            ) : (
              <pre className="text-xs whitespace-pre-wrap break-words font-mono">{content}</pre>
            ))}
          {truncated && (
            <div className="text-amber-400 text-xs p-2 border-t border-border mt-2">
              File truncated (exceeds the 1 MB viewer cap).
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

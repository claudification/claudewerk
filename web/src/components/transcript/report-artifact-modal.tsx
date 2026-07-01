import { ExternalLink, FileText, Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

/**
 * Views a host-local artifact (the /insights HTML report) that the broker proxies
 * from the owning sentinel. Fetches the AUTHED route (no public URL) and renders
 * the HTML in a SANDBOXED iframe via `srcdoc` -- `allow-scripts` WITHOUT
 * `allow-same-origin`, so the CC-generated report runs in an opaque origin and
 * cannot touch the control-panel origin or its cookies. Fetching first (rather
 * than pointing the iframe at the URL) lets us render a clean error instead of
 * the broker's raw JSON when the artifact is gone / the sentinel is offline.
 *
 * Lazy-loaded (LAZY LOAD covenant) -- only pulled when a report is opened.
 */
export function ReportArtifactModal({
  conversationId,
  relPath,
  title,
  onClose,
}: {
  conversationId: string
  relPath: string
  title: string
  onClose: () => void
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const url = `/api/conversations/${encodeURIComponent(conversationId)}/artifact?path=${encodeURIComponent(relPath)}`

  // Reset state synchronously when url changes (no stale frame)
  const [prevUrl, setPrevUrl] = useState(url)
  if (url !== prevUrl) {
    setPrevUrl(url)
    setHtml(null)
    setError(null)
  }

  useEffect(() => {
    let alive = true
    fetch(url, { credentials: 'same-origin' })
      .then(async res => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error || `Request failed (${res.status})`)
        }
        return res.text()
      })
      .then(text => {
        if (alive) setHtml(text)
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [url])

  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent className="max-w-[95vw] w-[1100px] h-[88vh] p-0 flex flex-col gap-0 top-[6vh] translate-y-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <FileText className="size-4 text-teal-400 shrink-0" />
          <DialogTitle className="text-xs truncate">{title}</DialogTitle>
          <span className="text-[10px] text-muted-foreground/60 font-mono ml-1 truncate">{relPath}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="size-3" />
            open
          </a>
        </div>

        <div className="flex-1 min-h-0 bg-white">
          {error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
              <TriangleAlert className="size-6 text-amber-400" />
              <div className="text-sm text-foreground">Report unavailable</div>
              <div className="text-xs text-muted-foreground max-w-md">{error}</div>
            </div>
          ) : html === null ? (
            <div className="flex h-full items-center justify-center bg-background">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <iframe
              title={title}
              srcDoc={html}
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              className="h-full w-full border-0 bg-white"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * LinkPreviewPane - mobile in-app preview for external links.
 *
 * Rendered once at the app root (survives transcript remounts). Opens via
 * openLinkPreview() from the markdown click delegate when an external link is
 * tapped on mobile. Slides up full-width from the bottom with a CLOSE + SHARE
 * top bar:
 *   - CLOSE returns to CLAUDEWERK instantly (the tap never navigated away).
 *   - SHARE opens the native share sheet (navigator.share) so the user can
 *     "Open in Safari" -- the escape hatch out of the standalone PWA.
 *
 * Body shows a live <iframe> when the site permits framing, otherwise a rich
 * link card (OG image/title/description). Either way the user is never trapped.
 */

import { ExternalLink, Loader2, Share, X } from 'lucide-react'
import { Dialog as SheetPrimitive } from 'radix-ui'
import { useEffect, useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { type LinkPreviewData, useLinkPreview } from './link-preview-bus'
import { SheetContent, SheetTitle } from './ui/sheet'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function LinkPreviewPane() {
  const { open, url, close } = useLinkPreview()
  const [data, setData] = useState<LinkPreviewData | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch framing + OG metadata whenever a new URL opens. Aborts if the pane
  // closes or the URL changes mid-flight so a slow fetch can't paint stale data.
  useEffect(() => {
    if (!open || !url) return
    let alive = true
    setData(null)
    setLoading(true)
    const ctrl = new AbortController()
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then((d: LinkPreviewData) => {
        if (alive) setData(d)
      })
      .catch(() => {
        // Network/abort -> treat as not-frameable; the card + SHARE still work.
        if (alive) setData({ url, frameable: false })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [open, url])

  async function handleShare() {
    haptic('tap')
    const title = data?.title || hostOf(url)
    // navigator.share is the reliable PWA escape hatch -- the native sheet
    // includes "Open in Safari" / Copy. Falls back to a new tab + clipboard
    // where Web Share is unavailable (desktop browsers, older WebViews).
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title })
        return
      } catch {
        // User dismissed the sheet, or share rejected -- fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      /* clipboard blocked */
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const host = hostOf(url)
  const title = data?.title || host

  return (
    <SheetPrimitive.Root
      open={open}
      onOpenChange={v => {
        if (!v) close()
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="h-[92dvh] gap-0 p-0"
        // Keep the iframe out of the focus trap's way; the top bar buttons are first.
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>

        {/* Top bar: CLOSE (left) | title (center) | SHARE (right) */}
        <div className="flex items-center gap-2 border-b border-border/60 px-2 py-2 bg-background">
          <button
            type="button"
            onClick={() => {
              haptic('tick')
              close()
            }}
            className="flex items-center gap-1 px-2 py-1.5 rounded text-foreground/80 hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Close"
          >
            <X className="size-4" />
            <span className="text-xs font-medium">Close</span>
          </button>

          <div className="min-w-0 flex-1 text-center">
            <div className="truncate text-xs font-medium text-foreground/90" title={url}>
              {title}
            </div>
            <div className="truncate text-[10px] text-muted-foreground font-mono">{host}</div>
          </div>

          <button
            type="button"
            onClick={handleShare}
            className="flex items-center gap-1 px-2 py-1.5 rounded text-accent hover:bg-muted/50 transition-colors"
            title="Share / open externally"
          >
            <Share className="size-4" />
            <span className="text-xs font-medium">Share</span>
          </button>
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-0 bg-background">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
            </div>
          )}

          {!loading && data?.frameable && (
            <iframe
              title={title}
              src={url}
              className="h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
            />
          )}

          {!loading && data && !data.frameable && <LinkCard data={data} host={host} onOpen={handleShare} />}
        </div>
      </SheetContent>
    </SheetPrimitive.Root>
  )
}

/**
 * Fallback card for sites that refuse framing. Shows OG image/title/description
 * and a prominent open-externally action -- so a blocked site still reads as a
 * real preview, never a blank box.
 */
function LinkCard({ data, host, onOpen }: { data: LinkPreviewData; host: string; onOpen: () => void }) {
  return (
    <div className="absolute inset-0 overflow-y-auto flex flex-col items-center px-5 py-8">
      <div className="w-full max-w-md rounded-lg border border-border/60 overflow-hidden bg-card">
        {data.image && <img src={data.image} alt="" className="w-full max-h-48 object-cover bg-muted" loading="lazy" />}
        <div className="p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
            {data.favicon && <img src={data.favicon} alt="" className="size-4 rounded-sm" loading="lazy" />}
            <span className="truncate">{data.siteName || host}</span>
          </div>
          <div className="text-sm font-semibold text-foreground leading-snug">{data.title || host}</div>
          {data.description && (
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{data.description}</p>
          )}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground text-center max-w-xs">
        This site cannot be shown inside the app. Open it in your browser instead.
      </p>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'mt-3 flex items-center gap-2 px-4 py-2.5 rounded-lg',
          'bg-accent text-accent-foreground font-medium text-sm',
          'hover:opacity-90 transition-opacity',
        )}
      >
        <ExternalLink className="size-4" />
        Open in browser
      </button>
    </div>
  )
}

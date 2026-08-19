/**
 * Html block: an ISOLATED HTML embed rendered in a SANDBOXED iframe --
 * `allow-scripts` WITHOUT `allow-same-origin`, so agent-authored HTML runs in an
 * opaque origin and can NEVER touch the control-panel origin, its cookies, or
 * localStorage (same posture as report-artifact-modal). The single `allow-same-origin`
 * omission is the whole isolation story -- do NOT add it.
 *
 * Source is either inline `content` (-> srcdoc) or a `url` (-> src; the agent host
 * uploads a local path to the blob store before it reaches us). Zoomable to
 * true-viewport fullscreen via useFullscreenEscape (position:fixed, no remount, so
 * iframe scroll/state survives the toggle) -- the same trick the Draw block uses.
 */

import { ExternalLink, Maximize2, Minimize2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useFullscreenEscape } from './use-fullscreen-escape'

// allow-scripts lets the embed run JS; allow-popups/-to-escape lets links open in a
// real tab. NO allow-same-origin -> opaque origin -> zero reach into the host page.
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

export interface HtmlBlockProps {
  content?: string
  url?: string
  height?: number
  label?: string
}

export function HtmlBlock({ content, url, height = 360, label }: HtmlBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useFullscreenEscape(containerRef, fullscreen)

  const title = label || 'HTML'
  const iframe = (
    <iframe
      title={title}
      // exactly one of src/srcDoc is set: url wins if present, else inline content.
      {...(url ? { src: url } : { srcDoc: content ?? '' })}
      sandbox={SANDBOX}
      className="h-full w-full border-0 bg-white"
    />
  )

  return (
    <div ref={containerRef} className={cn(fullscreen && 'fixed inset-0 z-[100] flex flex-col bg-background p-3')}>
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            title="Open in new tab"
          >
            <ExternalLink className="size-3" />
            open
          </a>
        )}
        <button
          type="button"
          onClick={() => setFullscreen(f => !f)}
          className={cn(
            'flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground',
            !url && 'ml-auto',
          )}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          {fullscreen ? 'exit' : 'zoom'}
        </button>
      </div>
      <div
        className={cn(
          'relative overflow-hidden rounded border border-border-subtle bg-white',
          fullscreen ? 'min-h-0 flex-1' : '',
        )}
        style={fullscreen ? undefined : { height }}
      >
        {iframe}
      </div>
    </div>
  )
}

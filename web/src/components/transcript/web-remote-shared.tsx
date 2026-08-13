/**
 * Shared bits for the remote-control (`web_*`) transcript renderers.
 *
 * Every web_* tool is relayed broker -> opted-in browser and comes back as MCP
 * content blocks wrapping a JSON payload (`{ ok, result }` flattened to the
 * result value by the MCP site). Unwrapping happens here, once, so each
 * renderer works on a plain object/array instead of re-parsing strings.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { extractMcpText } from './shared'
import type { ToolCaseInput } from './tool-case-types'

function remotePayload(ctx: ToolCaseInput): unknown {
  const text = extractMcpText(ctx.result, ctx.toolUseResult) ?? ctx.result
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function payloadObject(ctx: ToolCaseInput): Record<string, unknown> | null {
  const parsed = remotePayload(ctx)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

export function payloadArray(ctx: ToolCaseInput): unknown[] | null {
  const parsed = remotePayload(ctx)
  return Array.isArray(parsed) ? parsed : null
}

/** Summary line: a colored verb chip followed by whatever the op acted on. */
export function RemoteSummary({
  verb,
  tone = 'text-fuchsia-400',
  children,
}: {
  verb: string
  tone?: string
  children?: ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className={cn('shrink-0', tone)}>{verb}</span>
      {children}
    </span>
  )
}

/** Muted count/detail suffix ("3 shells", "1.2 KB", ...). */
export function Meta({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground/50 text-[10px] shrink-0">{children}</span>
}

export function ShellId({ id }: { id?: string }) {
  if (!id) return null
  return <span className="text-muted-foreground shrink-0">{id.slice(0, 8)}</span>
}

/** Screenshot result: the actual image, not a URL string. */
export function ShotView({ url, label }: { url: string; label: string }) {
  return (
    <div className="py-1 space-y-1">
      <img
        src={url}
        alt={label}
        className="max-w-sm max-h-64 rounded border border-border/50 hover:border-primary/50 transition-colors"
        loading="lazy"
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-[10px] font-mono text-accent hover:text-accent/80 underline"
      >
        open full size
      </a>
    </div>
  )
}

/** Compact row list used by the list_* ops. */
export function RowList({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-mono space-y-0.5 mt-1">{children}</div>
}

const CTRL_LABELS: Record<string, string> = {
  '\n': '⏎',
  '\r': '⏎',
  '\t': '⇥',
  '\x1b': 'ESC',
}

/** Render raw terminal bytes readably: newlines and control chars become caret
 *  notation instead of silently disappearing (or wrecking) the summary line. */
export function visibleBytes(data: string): string {
  return Array.from(data, ch => {
    const code = ch.charCodeAt(0)
    if (code > 31 && code !== 127) return ch
    if (CTRL_LABELS[ch]) return CTRL_LABELS[ch]
    return code === 127 ? '^?' : `^${String.fromCharCode(64 + code)}`
  }).join('')
}

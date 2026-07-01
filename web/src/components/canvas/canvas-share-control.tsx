/**
 * Owner share control for a hosted canvas -- a "Share" button in the canvas
 * header that opens a small panel: pick a permission tier (read / comment /
 * edit), copy the public link, or revoke. Revoking kills the link immediately
 * (the broker clears the token, so the public route 404s).
 */

import type { CanvasShareTier, CanvasSummary } from '@shared/protocol'
import { useState } from 'react'
import { haptic } from '@/lib/utils'
import { type CanvasShareState, useCanvasShare } from './use-canvas-share'

const TIERS: { tier: CanvasShareTier; label: string; hint: string }[] = [
  { tier: 'read', label: 'View only', hint: 'see the canvas + live cursors, no edits' },
  { tier: 'comment', label: 'Comment', hint: 'add notes, cannot change the design' },
  { tier: 'edit', label: 'Edit', hint: 'full co-edit' },
]

function ShareLink({ url, busy, revoke }: { url: string; busy: boolean; revoke: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    haptic('tap')
    await navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="space-y-1 pt-1 border-t border-border/60">
      <div className="flex items-center gap-1">
        <input
          readOnly
          value={url}
          aria-label="Share URL"
          onFocus={e => e.currentTarget.select()}
          className="flex-1 min-w-0 bg-muted/30 px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 px-1.5 py-0.5 border border-border hover:border-sky-400/60"
        >
          {copied ? 'ok' : 'copy'}
        </button>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={revoke}
        className="w-full px-2 py-1 border border-red-500/40 text-red-400/90 hover:border-red-500 disabled:opacity-50"
      >
        Revoke link
      </button>
    </div>
  )
}

function SharePanel({ s }: { s: CanvasShareState }) {
  return (
    <div className="absolute right-0 top-7 z-50 w-64 border border-border bg-background p-2 space-y-1.5 text-xs shadow-lg">
      <div className="text-[10px] uppercase tracking-wider text-sky-400/70 px-1">Public share</div>
      {TIERS.map(t => {
        const active = s.shared && s.tier === t.tier
        return (
          <button
            key={t.tier}
            type="button"
            disabled={s.busy}
            onClick={() => void s.setTier(t.tier)}
            className={`w-full text-left px-2 py-1 border transition-colors disabled:opacity-50 ${
              active ? 'border-emerald-400/60 text-emerald-300/90' : 'border-border hover:border-sky-400/60'
            }`}
          >
            <span className="font-mono">{t.label}</span>
            <span className="block text-[10px] text-muted-foreground/70">{t.hint}</span>
          </button>
        )
      })}
      {s.shared && s.url && <ShareLink url={s.url} busy={s.busy} revoke={() => void s.revoke()} />}
    </div>
  )
}

export function CanvasShareControl({ canvas }: { canvas: CanvasSummary }) {
  const [open, setOpen] = useState(false)
  const s = useCanvasShare(canvas)
  const btnCls = s.shared
    ? 'border-emerald-400/50 text-emerald-300/90 hover:border-emerald-400'
    : 'border-border text-muted-foreground hover:text-sky-300 hover:border-sky-400/60'

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          haptic('tap')
          setOpen(o => !o)
        }}
        className={`text-[11px] px-2 py-0.5 border transition-colors ${btnCls}`}
      >
        {s.shared ? `Shared - ${s.tier}` : 'Share'}
      </button>
      {open && <SharePanel s={s} />}
    </div>
  )
}

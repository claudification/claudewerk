import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** One bucket from GET /api/stats/tokens (the fields this chart reads). */
interface Bucket {
  bucketStart: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
}

const WINDOWS = ['30m', '2h', '5h', '1d'] as const
type Win = (typeof WINDOWS)[number]

/** Cache HIT ratio for a bucket: of everything fed to the model, the fraction
 *  served from cache (read) vs freshly billed (write + uncached input). */
function hitRatio(b: Bucket): number {
  const denom = b.cacheReadTokens + b.cacheWriteTokens + b.inputTokens
  return denom > 0 ? b.cacheReadTokens / denom : 0
}

function ratioColor(r: number): string {
  if (r >= 0.9) return 'var(--success)'
  if (r >= 0.7) return 'var(--warning)'
  return 'var(--destructive)'
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return `${n}`
}

/**
 * Per-conversation cache-hit ratio over time + the REAL 5m/1h cache-write split
 * (recorded, not guessed). Lazy-loaded from the expanded header. Fed by
 * /api/stats/tokens?conversationId=... (gated on read access to this conv).
 */
export function CacheHitChart({ conversationId, className }: { conversationId: string; className?: string }) {
  const [win, setWin] = useState<Win>('2h')
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let live = true
    setBuckets(null)
    fetch(`/api/stats/tokens?conversationId=${encodeURIComponent(conversationId)}&window=${win}`, {
      credentials: 'same-origin',
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { buckets: Bucket[] }) => live && setBuckets(d.buckets))
      .catch(() => live && setBuckets([]))
    return () => {
      live = false
    }
  }, [conversationId, win])

  const { nonEmpty, avg, write5m, write1h } = useMemo(() => {
    const bs = (buckets ?? []).filter(b => b.cacheReadTokens + b.cacheWriteTokens + b.inputTokens > 0)
    const read = bs.reduce((s, b) => s + b.cacheReadTokens, 0)
    const write = bs.reduce((s, b) => s + b.cacheWriteTokens, 0)
    const input = bs.reduce((s, b) => s + b.inputTokens, 0)
    const denom = read + write + input
    return {
      nonEmpty: bs,
      avg: denom > 0 ? read / denom : 0,
      write5m: bs.reduce((s, b) => s + b.cacheWrite5mTokens, 0),
      write1h: bs.reduce((s, b) => s + b.cacheWrite1hTokens, 0),
    }
  }, [buckets])

  const W = 240
  const H = 40
  const handleMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const n = nonEmpty.length
      if (!svgRef.current || n === 0) return
      const rect = svgRef.current.getBoundingClientRect()
      const barW = Math.max(2, (W - 4) / n - 1)
      const idx = Math.floor((e.clientX - rect.left - 2) / (barW + 1))
      setHoverIdx(idx >= 0 && idx < n ? idx : null)
    },
    [nonEmpty.length],
  )

  if (buckets === null) return <div className={cn('text-[10px] text-muted-foreground', className)}>cache/time …</div>
  if (nonEmpty.length === 0) return null

  const barW = Math.max(2, (W - 4) / nonEmpty.length - 1)
  const hovered = hoverIdx != null ? nonEmpty[hoverIdx] : null
  const writeTotal = write5m + write1h

  return (
    <div className={cn('text-[10px] font-mono space-y-0.5', className)}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">cache hit</span>
        {hovered ? (
          <span className="text-foreground tabular-nums">{(hitRatio(hovered) * 100).toFixed(0)}%</span>
        ) : (
          <span className="text-foreground tabular-nums">{(avg * 100).toFixed(0)}% avg</span>
        )}
        <div className="ml-auto flex gap-0.5">
          {WINDOWS.map(w => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              className={cn(
                'px-1 py-0 text-[9px]',
                w === win ? 'text-accent bg-accent/20' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        className="block cursor-crosshair"
        role="img"
        aria-label="Cache hit ratio over time"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {nonEmpty.map((b, i) => {
          const r = hitRatio(b)
          const barH = Math.max(1, r * (H - 4))
          const x = 2 + i * (barW + 1)
          return (
            <rect
              key={b.bucketStart}
              x={x}
              y={H - 2 - barH}
              width={barW}
              height={barH}
              fill={ratioColor(r)}
              rx={0.5}
              opacity={hoverIdx != null && hoverIdx !== i ? 0.4 : 1}
            />
          )
        })}
      </svg>
      {/* Real recorded 5m/1h cache-write split -- KNOWN, not guessed. */}
      {writeTotal > 0 && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>write</span>
          <span className="tabular-nums text-emerald-400">5m {fmtTokens(write5m)}</span>
          <span className="tabular-nums text-sky-400">1h {fmtTokens(write1h)}</span>
          <span className="tabular-nums">({Math.round((write1h / writeTotal) * 100)}% 1h)</span>
        </div>
      )}
    </div>
  )
}

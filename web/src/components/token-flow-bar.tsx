/**
 * TokenFlowBar -- the live fleet token-spend widget in the header. A tiny inline
 * stacked-bar sparkline (Little-Snitch-style living bar) that updates ~1Hz off
 * the token-flow ring. Hover/click opens a popover with a window selector
 * (5m/30m/2h/5h/1d), a global|profile toggle, the cache breakdown, and totals.
 *
 * Stack treatment A: the BAR HEIGHT is input + output (the "active" spend that
 * moves). cache-read dwarfs raw token counts and is the cheapest, so it is NOT
 * in the bars -- it lives in the popover totals. Tokens only for now; cost is a
 * later render-time multiply (model is carried per sample).
 */

import { Popover } from 'radix-ui'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  activeProfiles,
  bucketize,
  type FlowBucket,
  fetchWindow,
  getSamples,
  getVersion,
  seedRing,
  subscribe,
  windowEdges,
} from '@/hooks/token-flow-store'
import { haptic } from '@/lib/utils'

const WINDOWS = [
  { key: '5m', ms: 5 * 60_000, bucketMs: 5_000 },
  { key: '30m', ms: 30 * 60_000, bucketMs: 30_000 },
  { key: '2h', ms: 2 * 60 * 60_000, bucketMs: 120_000 },
  { key: '5h', ms: 5 * 60 * 60_000, bucketMs: 300_000 },
  { key: '1d', ms: 24 * 60 * 60_000, bucketMs: 1_200_000 },
] as const
type WindowKey = (typeof WINDOWS)[number]['key']
const RING_WINDOWS = new Set<WindowKey>(['5m', '30m', '2h'])
// Synthetic seed samples are 2-min server-bucket aggregates. They only fit views
// whose bucketMs is >= the seed granularity -- 2h (2-min buckets) qualifies; 5m
// and 30m do not.
const SYNTHETIC_OK = new Set<WindowKey>(['2h'])

const COLOR_OUTPUT = 'var(--accent)'
const COLOR_INPUT = 'var(--info)'

function windowCfg(key: WindowKey) {
  return WINDOWS.find(w => w.key === key) ?? WINDOWS[0]
}

/** Shared with THE WALL's P4 tile -- one token formatter per feed, not two. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Re-render on each ring tick. */
function useTokenTick(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/**
 * Y-axis scale that ignores outliers: p90 of non-zero bucket totals times a small
 * stretch. Single huge spikes (e.g. a giant tool result) clip at the top rather
 * than crushing every other bar to a pixel. Falls back to 1 when the window is
 * empty so the chart doesn't divide-by-zero.
 */
function scaleFor(buckets: FlowBucket[]): number {
  const totals: number[] = []
  for (const b of buckets) {
    const t = b.input + b.output
    if (t > 0) totals.push(t)
  }
  if (totals.length === 0) return 1
  totals.sort((a, b) => a - b)
  const idx = Math.min(totals.length - 1, Math.floor(totals.length * 0.9))
  return Math.max(1, totals[idx] * 1.5)
}

interface StackedBarsProps {
  buckets: FlowBucket[]
  width: number
  height: number
  gap?: number
  onHover?: (idx: number | null) => void
  hoverIdx?: number | null
}

/**
 * Inline stacked sparkline: input (bottom) + output (top), scaled to the busiest
 * bucket. THE token sparkline primitive -- exported because THE WALL's P4 tile
 * rides the same ring and must not draw a second one. (`cost-sparkline.tsx`,
 * which the P4 card first pointed at, is a cost WIDGET with its own window tabs
 * and dollar formatting, not a primitive.)
 */
export function StackedBars({ buckets, width, height, gap = 0.5, onHover, hoverIdx }: StackedBarsProps) {
  const n = Math.max(1, buckets.length)
  const slot = width / n
  const barW = Math.max(1, slot - gap)
  const scale = scaleFor(buckets)
  return (
    <svg
      width={width}
      height={height}
      className="block"
      role="img"
      aria-label="Token flow"
      onMouseMove={onHover ? e => onHover(Math.floor((e.nativeEvent.offsetX / width) * n)) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      {buckets.map((b, i) => {
        // Clip bars taller than the p90-derived scale: a huge outlier hits the
        // top instead of crushing every other bar to a single pixel.
        const totalH = Math.min(height, ((b.input + b.output) / scale) * height)
        const totalRaw = b.input + b.output
        const inH = totalRaw > 0 ? totalH * (b.input / totalRaw) : 0
        const outH = totalH - inH
        const x = i * slot
        const dim = hoverIdx != null && hoverIdx !== i ? 0.4 : 1
        return (
          <g key={b.bucketStart} opacity={dim}>
            {totalRaw > 0 && (
              <rect x={x} y={height - inH} width={barW} height={Math.max(0.5, inH)} fill={COLOR_INPUT} />
            )}
            {b.output > 0 && (
              <rect x={x} y={height - inH - outH} width={barW} height={Math.max(0.5, outH)} fill={COLOR_OUTPUT} />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Dense global buckets for a window: ring (short) or server fetch (long). */
function useWindowBuckets(windowKey: WindowKey): FlowBucket[] {
  useTokenTick()
  const cfg = windowCfg(windowKey)
  const isRing = RING_WINDOWS.has(windowKey)
  const [fetched, setFetched] = useState<FlowBucket[]>([])

  useEffect(() => {
    if (isRing) return
    let alive = true
    const load = () => {
      fetchWindow(windowKey, 'global')
        .then(r => {
          if (!alive) return
          const count = Math.max(1, Math.ceil((r.to - r.from) / r.bucketMs))
          const dense: FlowBucket[] = Array.from({ length: count }, (_, i) => ({
            bucketStart: r.from + i * r.bucketMs,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }))
          for (const b of r.buckets) {
            const idx = Math.floor((b.bucketStart - r.from) / r.bucketMs)
            const d = dense[idx]
            if (!d) continue
            d.input += b.inputTokens
            d.output += b.outputTokens
            d.cacheRead += b.cacheReadTokens
            d.cacheWrite += b.cacheWriteTokens
          }
          setFetched(dense)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [windowKey, isRing])

  if (isRing) {
    const { from, to } = windowEdges(Date.now(), cfg.ms, cfg.bucketMs)
    return bucketize(getSamples(), from, to, cfg.bucketMs, { includeSynthetic: SYNTHETIC_OK.has(windowKey) })
  }
  return fetched
}

interface Totals {
  input: number
  output: number
  cacheRead: number
}

function sumTotals(buckets: FlowBucket[]): Totals {
  return buckets.reduce(
    (acc, b) => {
      acc.input += b.input
      acc.output += b.output
      acc.cacheRead += b.cacheRead
      return acc
    },
    { input: 0, output: 0, cacheRead: 0 },
  )
}

interface ProfileRow {
  sentinelId: string
  profile: string
  input: number
  output: number
}

/** Per-profile totals over a ring window (short windows only). */
function profileRowsFromRing(windowKey: WindowKey): ProfileRow[] {
  const cfg = windowCfg(windowKey)
  const { from, to } = windowEdges(Date.now(), cfg.ms, cfg.bucketMs)
  const includeSynthetic = SYNTHETIC_OK.has(windowKey)
  const rows = activeProfiles().map(p => {
    const series = bucketize(getSamples(), from, to, cfg.ms, { match: p, includeSynthetic })
    const t = sumTotals(series)
    return { sentinelId: p.sentinelId, profile: p.profile, input: t.input, output: t.output }
  })
  return rows.filter(r => r.input + r.output > 0).sort((a, b) => b.output + b.input - (a.output + a.input))
}

function TotalsLine({ totals }: { totals: Totals }) {
  return (
    <div className="flex items-center gap-3 text-[10px] tabular-nums">
      <span style={{ color: COLOR_OUTPUT }}>out {formatTokens(totals.output)}</span>
      <span style={{ color: COLOR_INPUT }}>in {formatTokens(totals.input)}</span>
      <span className="text-fg-dim">cache {formatTokens(totals.cacheRead)}</span>
    </div>
  )
}

function TokenFlowPanel() {
  const [windowKey, setWindowKey] = useState<WindowKey>('5m')
  const [perProfile, setPerProfile] = useState(false)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const buckets = useWindowBuckets(windowKey)
  useTokenTick() // keep profile rows fresh on ring windows
  const totals = useMemo(() => sumTotals(buckets), [buckets])
  const hovered = hoverIdx != null ? buckets[hoverIdx] : null
  const profileRows = perProfile && RING_WINDOWS.has(windowKey) ? profileRowsFromRing(windowKey) : []

  return (
    <div className="space-y-2 font-mono">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-fg-dim uppercase tracking-wider">Token flow</div>
        <div className="flex gap-0.5">
          {WINDOWS.map(w => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWindowKey(w.key)}
              className={`px-1 text-[9px] ${w.key === windowKey ? 'text-accent bg-accent/20' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {w.key}
            </button>
          ))}
        </div>
      </div>

      <StackedBars buckets={buckets} width={256} height={48} onHover={setHoverIdx} hoverIdx={hoverIdx} />

      {hovered ? (
        <TotalsLine totals={{ input: hovered.input, output: hovered.output, cacheRead: hovered.cacheRead }} />
      ) : (
        <div className="flex items-center justify-between">
          <TotalsLine totals={totals} />
          <button
            type="button"
            onClick={() => setPerProfile(p => !p)}
            className={`px-1.5 text-[9px] rounded ${perProfile ? 'text-accent bg-accent/20' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {perProfile ? 'global' : 'per profile'}
          </button>
        </div>
      )}

      {perProfile && !RING_WINDOWS.has(windowKey) && (
        <div className="text-[9px] text-fg-dim">per-profile breakdown: 5m / 30m / 2h windows</div>
      )}
      {profileRows.length > 0 && (
        <div className="space-y-1 border-t border-border pt-1">
          {profileRows.map(r => (
            <div key={`${r.sentinelId}\0${r.profile}`} className="flex items-center gap-2 text-[10px] tabular-nums">
              <span className="text-muted-foreground truncate max-w-24">{r.profile}</span>
              <span className="ml-auto" style={{ color: COLOR_OUTPUT }}>
                {formatTokens(r.output)}
              </span>
              <span style={{ color: COLOR_INPUT }}>{formatTokens(r.input)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function TokenFlowBar() {
  const [open, setOpen] = useState(false)
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  useTokenTick()

  // Seed the ring once on mount so the bar isn't empty before live events land.
  useEffect(() => {
    void seedRing()
  }, [])

  const { from, to } = windowEdges(Date.now(), 5 * 60_000, 5_000)
  const miniBuckets = bucketize(getSamples(), from, to, 5_000)
  const hasData = miniBuckets.some(b => b.input + b.output > 0)

  function handleMouseEnter() {
    hoverTimeout.current = setTimeout(() => setOpen(true), 300)
  }
  function handleMouseLeave() {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
    hoverTimeout.current = setTimeout(() => setOpen(false), 200)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-pointer select-none hover:opacity-80 transition-opacity flex items-center"
          title="Token flow (last 5m)"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            haptic('tap')
            setOpen(o => !o)
          }}
        >
          <span className="inline-flex items-center border border-border-subtle rounded-[3px] px-1 py-0.5">
            {hasData ? (
              <StackedBars buckets={miniBuckets} width={108} height={16} />
            ) : (
              <span className="text-[10px] text-fg-faint">tok</span>
            )}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-72 rounded border border-border bg-background/95 backdrop-blur-sm shadow-lg p-3"
          sideOffset={8}
          align="start"
          onMouseEnter={() => {
            if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
          }}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <TokenFlowPanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

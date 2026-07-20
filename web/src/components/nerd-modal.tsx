/**
 * Details for Nerds - tabbed diagnostic modal
 * Tabs: Traffic (WS stats), Cache (LIFO conversation cache), Subscriptions, Debug Log
 */

import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

const ConnectionsTab = lazy(() => import('./nerd-connections-tab'))

import { useConversationsStore } from '@/hooks/use-conversations'
import { getRates, subscribe as subscribeStats } from '@/hooks/ws-stats'
import { clearLog, copyLogText, getLogEntries, subscribeLog } from '@/lib/debug-log'
import {
  categoryStats,
  clearEntries as clearPerfEntries,
  durationColor,
  getEntries as getPerfEntries,
  isPerfEnabled,
  type PerfCategory,
  type PerfEntry,
  subscribe as subscribePerfMetrics,
} from '@/lib/perf-metrics'
import { buildPerfReport, PERF_CATEGORIES, SIGNIFICANT_THRESHOLD_MS } from '@/lib/perf-report'
import { formatStoreReport, humanBytes, measureStore, type StoreReport } from '@/lib/store-sizeof'
import { extractProjectLabel } from '@/lib/types'
import { clearCacheAndReload, cn } from '@/lib/utils'
import { MessageImpactTable } from './nerd-modal-message-impact'

interface ServerStats {
  uptime: number
  conversations: { total: number; active: number; idle: number; ended: number }
  connections: { total: number; legacy: number; v2: number }
  traffic: {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
  channels: Record<string, number>
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatBytes(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatMemory(entries: number): string {
  // Rough estimate: ~2KB per transcript entry average
  const kb = entries * 2
  if (kb < 1024) return `~${kb}KB`
  return `~${(kb / 1024).toFixed(1)}MB`
}

function StatRow({ label, value, accent, dim }: { label: string; value: string; accent?: boolean; dim?: boolean }) {
  const valueColor = accent ? 'text-success' : dim ? 'text-comment' : 'text-primary'
  return (
    <div className="flex justify-between py-0.5 border-b border-primary/8">
      <span className="text-foreground">{label}</span>
      <span className={`${valueColor} tabular-nums`}>{value}</span>
    </div>
  )
}

type Tab = 'traffic' | 'cache' | 'sw' | 'log' | 'perf' | 'conns' | 'heap'

const NERD_TABS: { id: Tab; label: string }[] = [
  { id: 'cache', label: 'Cache' },
  { id: 'heap', label: 'Heap' },
  { id: 'conns', label: 'Conns' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'perf', label: 'Perf' },
  { id: 'sw', label: 'SW' },
  { id: 'log', label: 'Log' },
]

function TrafficTab({ serverStats, fetchError }: { serverStats: ServerStats | null; fetchError: string | null }) {
  const clientRates = useSyncExternalStore(subscribeStats, getRates)
  const channelEntries = serverStats ? Object.entries(serverStats.channels) : []

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Client (browser WS)</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="msg in" value={`${clientRates.msgInPerSec.toFixed(1)}/s`} />
          <StatRow label="msg out" value={`${clientRates.msgOutPerSec.toFixed(1)}/s`} />
          <StatRow label="bytes in" value={formatBytes(clientRates.bytesInPerSec)} />
          <StatRow label="bytes out" value={formatBytes(clientRates.bytesOutPerSec)} />
        </div>
      </div>

      {fetchError && <div className="text-[11px] text-red-400">Server fetch error: {fetchError}</div>}

      {serverStats && (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Server</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <StatRow label="uptime" value={formatUptime(serverStats.uptime)} />
              <StatRow label="conversations" value={String(serverStats.conversations.total)} />
              <StatRow label="active" value={String(serverStats.conversations.active)} accent />
              <StatRow label="connections" value={String(serverStats.connections.total)} />
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Server Traffic</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <StatRow label="msg in" value={`${serverStats.traffic.in.messagesPerSec}/s`} />
              <StatRow label="msg out" value={`${serverStats.traffic.out.messagesPerSec}/s`} />
              <StatRow label="bytes in" value={formatBytes(serverStats.traffic.in.bytesPerSec)} />
              <StatRow label="bytes out" value={formatBytes(serverStats.traffic.out.bytesPerSec)} />
            </div>
          </div>

          {channelEntries.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-comment mb-2">
                Channels ({channelEntries.length})
              </div>
              <div className="max-h-32 overflow-y-auto">
                {channelEntries.map(([name, count]) => (
                  <StatRow key={name} label={name} value={String(count)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CacheTab() {
  const mru = useConversationsStore(s => s.conversationMru)
  const conversationsById = useConversationsStore(s => s.conversationsById)
  const transcripts = useConversationsStore(s => s.transcripts)
  const events = useConversationsStore(s => s.events)
  const selected = useConversationsStore(s => s.selectedConversationId)
  const prefs = useConversationsStore(s => s.controlPanelPrefs)

  const cachedIds = Object.keys(transcripts).filter(id => (transcripts[id]?.length ?? 0) > 0)
  const totalEntries = cachedIds.reduce((sum, id) => sum + (transcripts[id]?.length ?? 0), 0)
  const totalEvents = cachedIds.reduce((sum, id) => sum + (events[id]?.length ?? 0), 0)

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">LIFO Cache Settings</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="cache size" value={String(prefs.sessionCacheSize)} />
          <StatRow label="timeout" value={prefs.sessionCacheTimeout > 0 ? `${prefs.sessionCacheTimeout}m` : 'never'} />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Memory</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          <StatRow label="cached conversations" value={String(cachedIds.length)} accent />
          <StatRow label="transcript entries" value={String(totalEntries)} />
          <StatRow label="hook events" value={String(totalEvents)} />
          <StatRow label="est. memory" value={formatMemory(totalEntries + totalEvents)} />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Cached Conversations (MRU order)</div>
        <div className="max-h-48 overflow-y-auto space-y-1">
          {(() => {
            const cachedSet = new Set(cachedIds)
            const out: ReactNode[] = []
            for (const { id } of mru) {
              if (!cachedSet.has(id)) continue
              const conversation = conversationsById[id]
              const name =
                conversation?.title || (conversation ? extractProjectLabel(conversation.project) : '') || id.slice(0, 8)
              const entryCount = transcripts[id]?.length ?? 0
              const isSelected = id === selected
              out.push(
                <div
                  key={id}
                  className={cn('flex items-center gap-2 py-1 px-2 rounded text-[11px]', isSelected && 'bg-accent/10')}
                >
                  {isSelected && <span className="size-1.5 rounded-full bg-accent shrink-0" />}
                  <span className={cn('truncate flex-1', isSelected ? 'text-accent' : 'text-foreground')}>{name}</span>
                  <span className="text-comment tabular-nums shrink-0">{entryCount} entries</span>
                </div>,
              )
            }
            return out
          })()}
          {cachedIds.length === 0 && <div className="text-[11px] text-comment">No conversations cached</div>}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-comment mb-2">WS Subscriptions</div>
        <div className="max-h-32 overflow-y-auto space-y-0.5">
          {cachedIds.map(id => {
            const conversation = conversationsById[id]
            const name =
              conversation?.title || (conversation ? extractProjectLabel(conversation.project) : '') || id.slice(0, 8)
            return (
              <div key={id} className="text-[10px] text-foreground font-mono">
                <span className="text-success">SUB</span> {name}
                <span className="text-comment"> (events, transcript, tasks, bg_output)</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-cyan-400/70',
  log: 'text-foreground/80',
}

function LogTab() {
  const [entries, setEntries] = useState(getLogEntries)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return subscribeLog(() => {
      setEntries([...getLogEntries()])
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    })
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            copyLogText()
          }}
          className="text-[10px] text-primary hover:text-primary px-2 py-0.5 border border-primary/20 rounded"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={() => {
            clearLog()
            setEntries([])
          }}
          className="text-[10px] text-red-400 hover:text-red-300 px-2 py-0.5 border border-primary/20 rounded"
        >
          Clear
        </button>
        <span className="text-[10px] text-comment ml-auto">{entries.length} entries</span>
      </div>
      <div ref={scrollRef} className="max-h-64 overflow-y-auto bg-black/30 rounded p-2 space-y-0.5">
        {entries.length === 0 ? (
          <div className="text-[11px] text-comment">No log entries</div>
        ) : (
          entries.map((entry, i) => {
            const ts = new Date(entry.t).toISOString().slice(11, 23)
            return (
              <div
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
                // biome-ignore lint/suspicious/noArrayIndexKey: display-only log entries, no stable IDs
                key={i}
                className={`flex gap-2 font-mono text-[10px] leading-relaxed ${LEVEL_COLORS[entry.level] || 'text-foreground'}`}
              >
                <span className="text-muted-foreground/40 shrink-0 select-none">{ts}</span>
                <span className="whitespace-pre-wrap break-all">{entry.args}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function SwTab() {
  const [swStatus, setSwStatus] = useState('...')
  const [cacheInfo, setCacheInfo] = useState<Array<{ name: string; count: number; sizeKB: number }>>([])
  const [totalKB, setTotalKB] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      if (!('serviceWorker' in navigator)) {
        setSwStatus('unsupported')
        setLoading(false)
        return
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js')
        setSwStatus(reg?.active ? 'active' : reg?.waiting ? 'waiting' : reg ? 'installing' : 'not registered')
      } catch {
        setSwStatus('error')
      }
      try {
        const keys = await caches.keys()
        const infos = await Promise.all(
          keys.map(async name => {
            const cache = await caches.open(name)
            const entries = await cache.keys()
            const sizes = await Promise.all(
              entries.map(async req => {
                try {
                  const res = await cache.match(req)
                  if (res) return (await res.clone().blob()).size / 1024
                } catch {}
                return 0
              }),
            )
            const sizeKB = Math.round(sizes.reduce((a, b) => a + b, 0))
            return { name, count: entries.length, sizeKB }
          }),
        )
        const total = infos.reduce((s, i) => s + i.sizeKB, 0)
        setCacheInfo(infos)
        setTotalKB(Math.round(total))
      } catch {}
      setLoading(false)
    }
    // react-doctor-disable-next-line react-doctor/no-initialize-state
    load()
  }, [])

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-comment">Service Worker</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <StatRow
          label="status"
          value={loading ? '...' : swStatus}
          accent={swStatus === 'active'}
          dim={swStatus === 'not registered' || swStatus === 'unsupported'}
        />
        <StatRow label="total cached" value={totalKB > 1024 ? `${(totalKB / 1024).toFixed(1)} MB` : `${totalKB} KB`} />
      </div>

      {cacheInfo.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wider text-comment mt-3">Caches</div>
          {cacheInfo.map(c => (
            <div key={c.name} className="flex items-center justify-between py-1 border-b border-primary/8 text-[11px]">
              <span className="text-foreground truncate mr-2 flex-1">{c.name}</span>
              <span className="text-comment shrink-0 mr-3">{c.count} files</span>
              <span className="text-primary tabular-nums shrink-0">
                {c.sizeKB > 1024 ? `${(c.sizeKB / 1024).toFixed(1)} MB` : `${c.sizeKB} KB`}
              </span>
            </div>
          ))}
        </>
      )}

      {cacheInfo.length === 0 && !loading && (
        <div className="text-[11px] text-comment">No caches found. SW may not be registered yet.</div>
      )}

      <div className="mt-4 pt-3 border-t border-primary/12">
        <button
          type="button"
          onClick={() => clearCacheAndReload()}
          className="px-3 py-1 text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
        >
          Clear Cache & Reload
        </button>
      </div>
    </div>
  )
}

const CAT_COLORS: Record<PerfCategory, string> = {
  render: 'text-primary',
  grouping: 'text-event-prompt',
  ws: 'text-info',
  scroll: 'text-success',
  transcript: 'text-warning',
  message: 'text-event-prompt',
  other: 'text-muted-foreground',
}

function PerfTab() {
  const entries = useSyncExternalStore(subscribePerfMetrics, getPerfEntries) as PerfEntry[]
  const scrollRef = useRef<HTMLDivElement>(null)
  const enabled = isPerfEnabled()
  const [significantOnly, setSignificantOnly] = useState(false)

  const visibleEntries = significantOnly ? entries.filter(e => e.durationMs >= SIGNIFICANT_THRESHOLD_MS) : entries

  // biome-ignore lint/correctness/useExhaustiveDependencies: entries.length is a dep key to trigger scroll on new entries; scrollRef is a stable ref
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries.length])

  if (!enabled) {
    return (
      <div className="text-center text-comment text-xs py-8">
        Performance monitor is <span className="text-red-400">OFF</span>
        <br />
        <span className="text-[10px] mt-1 block">Enable in Settings &gt; Developer &gt; Performance monitor</span>
      </div>
    )
  }

  const stats: Array<{ cat: PerfCategory } & ReturnType<typeof categoryStats>> = []
  for (const cat of PERF_CATEGORIES) {
    const s = { cat, ...categoryStats(cat) }
    if (s.count > 0) stats.push(s)
  }

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {stats.map(s => (
            <div key={s.cat} className="bg-surface-inset border border-primary/12 px-2 py-1.5">
              <div className={cn('text-[10px] uppercase tracking-wider font-bold', CAT_COLORS[s.cat])}>{s.cat}</div>
              <div className="text-[10px] text-foreground mt-0.5">
                {s.count} samples -- avg <span className={durationColor(s.avg)}>{s.avg.toFixed(1)}ms</span> -- p95{' '}
                <span className={durationColor(s.p95)}>{s.p95.toFixed(1)}ms</span> -- max{' '}
                <span className={durationColor(s.max)}>{s.max.toFixed(1)}ms</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-message impact rollup */}
      <MessageImpactTable entries={entries} />

      {/* Controls */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-comment">
          {significantOnly ? `${visibleEntries.length}/${entries.length}` : entries.length} entries
        </span>
        <div className="flex items-center gap-3">
          <label className="text-[10px] text-comment hover:text-foreground flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={significantOnly}
              onChange={e => setSignificantOnly(e.target.checked)}
              className="accent-primary"
            />
            Significant only (&ge;{SIGNIFICANT_THRESHOLD_MS}ms)
          </label>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(buildPerfReport({ significantOnly }))
            }}
            className="text-[10px] text-comment hover:text-foreground transition-colors"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={clearPerfEntries}
            className="text-[10px] text-comment hover:text-foreground transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Entry list */}
      <div ref={scrollRef} className="max-h-[300px] overflow-y-auto space-y-0">
        {visibleEntries.length === 0 ? (
          <div className="text-center text-comment text-[10px] py-4">
            {entries.length === 0
              ? 'No entries yet -- interact with the dashboard'
              : `No entries \u2265${SIGNIFICANT_THRESHOLD_MS}ms`}
          </div>
        ) : (
          visibleEntries.slice(-100).map((e, i) => {
            const time = new Date(e.t).toLocaleTimeString('en-GB', { hour12: false })
            const barWidth = Math.min(100, (e.durationMs / 50) * 100)
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: traffic events share timestamps, no stable unique key
                key={`${e.t}-${i}`}
                className="flex items-center gap-2 py-0.5 px-1 text-[10px] hover:bg-surface-inset/50 border-b border-primary/4"
              >
                <span className="text-comment w-16 shrink-0">{time}</span>
                <span className={cn('w-14 shrink-0 uppercase tracking-wider', CAT_COLORS[e.category])}>
                  {e.category}
                </span>
                <span className="w-20 shrink-0 truncate text-foreground">{e.label}</span>
                <span className={cn('w-14 shrink-0 text-right tabular-nums', durationColor(e.durationMs))}>
                  {e.durationMs.toFixed(1)}ms
                </span>
                <div className="flex-1 min-w-0 h-2 bg-surface-inset relative overflow-hidden">
                  <div
                    className={cn(
                      'absolute inset-y-0 left-0',
                      e.durationMs < 5
                        ? 'bg-emerald-500/40'
                        : e.durationMs < 16
                          ? 'bg-primary/40'
                          : e.durationMs < 50
                            ? 'bg-amber-500/40'
                            : 'bg-red-500/40',
                    )}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                {e.detail && <span className="text-comment truncate max-w-24 text-[9px]">{e.detail}</span>}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** One row of the heap breakdown: cells keyed by column so there's no array-index key. */
function HeapRow({ cells }: { cells: { k: string; text: string; cn: string }[] }) {
  return (
    <div className="flex items-center gap-2 py-0.5 border-b border-primary/8 text-[10px] font-mono">
      {cells.map(c => (
        <span key={c.k} className={c.cn}>
          {c.text}
        </span>
      ))}
    </div>
  )
}

/**
 * Heap tab -- walks the live Zustand store and estimates retained bytes per
 * slice + per-conversation, on demand. The walker reads string.length only
 * (no JSON.stringify), so it is safe to run against a multi-GB store. Built to
 * diagnose the control-panel memory leak: copy the report, paste for analysis.
 */
function HeapTab() {
  const [report, setReport] = useState<StoreReport | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [copied, setCopied] = useState(false)

  const measure = useCallback(() => {
    setMeasuring(true)
    // Defer one tick so the "measuring…" label paints before the walk blocks
    // the main thread.
    setTimeout(() => {
      try {
        const state = useConversationsStore.getState() as unknown as Record<string, unknown>
        setReport(measureStore(state))
      } finally {
        setMeasuring(false)
      }
    }, 16)
  }, [])

  const copy = useCallback(() => {
    if (!report) return
    // react-doctor-disable-next-line react-doctor/rendering-hydration-mismatch-time
    navigator.clipboard.writeText(formatStoreReport(report, new Date().toISOString()))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [report])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={measure}
          disabled={measuring}
          className="text-[10px] text-primary hover:text-primary px-2 py-0.5 border border-primary/20 rounded disabled:opacity-50"
        >
          {measuring ? 'Measuring…' : 'Measure heap'}
        </button>
        {report && (
          <button
            type="button"
            onClick={copy}
            className="text-[10px] text-success hover:text-success px-2 py-0.5 border border-primary/20 rounded"
          >
            {copied ? 'Copied!' : 'Copy report'}
          </button>
        )}
        {report && (
          <span className="text-[10px] text-comment ml-auto tabular-nums">
            {humanBytes(report.total)} · {report.nodes.toLocaleString()} nodes · {report.elapsedMs}ms
            {report.truncated && <span className="text-red-400"> · TRUNCATED</span>}
          </span>
        )}
      </div>

      {!report && !measuring && (
        <div className="text-[11px] text-comment py-4">
          Walks the live store (transcripts, events, subagents, streaming buffers, …) and estimates retained bytes per
          slice and per-conversation. Reads string lengths only -- safe on a multi-GB store. Click <em>Measure heap</em>
          , then <em>Copy report</em>.
        </div>
      )}

      {report && (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Top-level slices</div>
            <div className="max-h-40 overflow-y-auto">
              {report.slices.flatMap(s =>
                s.bytes >= 1024
                  ? [
                      <HeapRow
                        key={s.key}
                        cells={[
                          { k: 'key', text: s.key, cn: 'text-foreground truncate flex-1' },
                          { k: 'kind', text: s.kind, cn: 'text-comment shrink-0 w-10 text-right' },
                          {
                            k: 'count',
                            text: String(s.count),
                            cn: 'text-comment shrink-0 w-14 text-right tabular-nums',
                          },
                          {
                            k: 'size',
                            text: humanBytes(s.bytes),
                            cn: 'text-primary shrink-0 w-20 text-right tabular-nums',
                          },
                        ]}
                      />,
                    ]
                  : [],
              )}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">
              Per-key (top retainers · maxItem = largest single item)
            </div>
            <div className="max-h-48 overflow-y-auto">
              {report.subs.flatMap(s =>
                s.bytes >= 1024
                  ? [
                      <HeapRow
                        key={`${s.slice}:${s.subKey}`}
                        cells={[
                          { k: 'slice', text: s.slice, cn: 'text-comment shrink-0 w-20 truncate' },
                          { k: 'sub', text: s.subKey, cn: 'text-foreground truncate flex-1' },
                          {
                            k: 'count',
                            text: String(s.count),
                            cn: 'text-comment shrink-0 w-12 text-right tabular-nums',
                          },
                          {
                            k: 'size',
                            text: humanBytes(s.bytes),
                            cn: 'text-primary shrink-0 w-16 text-right tabular-nums',
                          },
                          {
                            k: 'max',
                            text: humanBytes(s.maxItemBytes),
                            cn: 'text-warning shrink-0 w-16 text-right tabular-nums',
                          },
                        ]}
                      />,
                    ]
                  : [],
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function NerdModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('cache')
  // react-doctor-disable-next-line react-doctor/no-derived-state -- async polling state, not derived from props/other state
  const [serverStats, setServerStats] = useState<ServerStats | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats', { credentials: 'same-origin' })
      if (!res.ok) {
        setFetchError(`HTTP ${res.status}`)
        return
      }
      setServerStats(await res.json())
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'fetch failed')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    fetchStats()
    const id = setInterval(fetchStats, 1000)
    return () => clearInterval(id)
  }, [open, fetchStats])

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden font-mono flex flex-col p-0">
        <div className="p-4 pb-0">
          <DialogTitle className="sr-only">Details for Nerds</DialogTitle>
          <pre className="text-primary text-[10px] leading-tight mb-3 select-none text-center">
            {`┌─────────────────────────────────┐
│      DETAILS FOR NERDS          │
└─────────────────────────────────┘`}
          </pre>

          <div className="flex gap-1 mb-3">
            {NERD_TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'px-3 py-1 text-[10px] uppercase tracking-wider transition-colors',
                  tab === t.id
                    ? 'bg-primary/20 text-primary border border-primary/40'
                    : 'text-comment border border-transparent hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {tab === 'traffic' && <TrafficTab serverStats={serverStats} fetchError={fetchError} />}
          {tab === 'cache' && <CacheTab />}
          {tab === 'heap' && <HeapTab />}
          {tab === 'conns' && (
            <Suspense fallback={<div className="text-[11px] text-comment py-4 text-center">Loading…</div>}>
              <ConnectionsTab />
            </Suspense>
          )}
          {tab === 'perf' && <PerfTab />}
          {tab === 'sw' && <SwTab />}
          {tab === 'log' && <LogTab />}
        </div>

        <div className="text-center text-[10px] text-comment py-2 border-t border-primary/12">
          <kbd className="px-1 py-0.5 bg-primary/12 text-primary">Esc</kbd> to close
        </div>
      </DialogContent>
    </Dialog>
  )
}

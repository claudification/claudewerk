// One SENTINEL on THE CANVAS: host daemon identity, connection status, and a
// usage bar pair (5h / 7d) per profile. Conversations it hosts link to it via
// faint edges (accentuated on hover).
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { SentinelNodeData, SentinelProfileRow } from './canvas-types'

function usageTone(pct: number): string {
  if (pct >= 90) return 'bg-destructive'
  if (pct >= 70) return 'bg-warning'
  return 'bg-active'
}

function UsageBar({ label, pct }: { label: string; pct?: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-4 shrink-0 text-[8px] uppercase text-muted-foreground/60">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        {typeof pct === 'number' && (
          <div className={cn('h-full rounded-full', usageTone(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
        )}
      </div>
      <span className="w-7 shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">
        {typeof pct === 'number' ? `${Math.round(pct)}%` : '--'}
      </span>
    </div>
  )
}

function ProfileBadge({ p }: { p: SentinelProfileRow }) {
  if (p.error) return <span className="ml-auto shrink-0 text-[9px] text-destructive">{p.error}</span>
  if (!p.authed) return <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">not authed</span>
  return null
}

function PoolChip({ pool }: { pool?: string }) {
  if (!pool) return null
  return <span className="shrink-0 rounded border border-border px-1 text-[8px] text-muted-foreground">{pool}</span>
}

function ProfileRow({ p }: { p: SentinelProfileRow }) {
  return (
    <div className="border-t border-border/50 px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[10px] font-medium">{p.name}</span>
        <PoolChip pool={p.pool} />
        <ProfileBadge p={p} />
      </div>
      {p.authed && !p.error && (
        <div className="mt-1 space-y-0.5">
          <UsageBar label="5h" pct={p.fiveHourPct} />
          <UsageBar label="7d" pct={p.sevenDayPct} />
        </div>
      )}
    </div>
  )
}

function SentinelHeader({ d }: { d: SentinelNodeData }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', d.connected && 'animate-pulse')}
        style={{ backgroundColor: d.connected ? 'var(--color-active)' : 'var(--color-ended)' }}
      />
      <span className="truncate font-mono text-xs font-bold uppercase tracking-wide">{d.alias}</span>
      <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
        sentinel - {d.conversationCount} conv{d.conversationCount === 1 ? '' : 's'}
      </span>
    </div>
  )
}

export function SentinelNode({ data }: NodeProps) {
  const d = data as SentinelNodeData
  return (
    <div className="w-[280px] overflow-hidden rounded-xl border border-border bg-card/90 shadow-sm">
      <SentinelHeader d={d} />
      {d.hostname && <div className="px-3 pb-1 text-[9px] text-muted-foreground/60">{d.hostname}</div>}
      {d.profiles.map(p => (
        <ProfileRow key={p.name} p={p} />
      ))}
      <Handle type="source" position={Position.Right} className="!bg-border !border-border" />
    </div>
  )
}

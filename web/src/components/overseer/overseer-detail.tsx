/**
 * The detail pane: one run, in full.
 *
 * Layout mirrors the order you actually ask the questions in -- who is this and
 * how does it stand, what can I do about it, what are the numbers, who is
 * working, what does the DAG think, and only then the logs.
 */

import type { EpicInspectResult } from '@shared/protocol'
import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { ago, Empty, Stat, StatusPill } from './overseer-bits'
import { OverseerControls } from './overseer-controls'
import { OverseerDag } from './overseer-dag'
import { OverseerSeats } from './overseer-seats'
import { OverseerBaton, OverseerBeats, OverseerDigest, type OverseerTab, OverseerTabStrip } from './overseer-tabs'

/** Everything the heading DERIVES, in one place. Pulled out of the component
 *  because a header that is 90% `?.` and `??` reads as complicated when the only
 *  complicated thing about it is that a run may not exist yet. */
export function headFacts(data: EpicInspectResult) {
  const run = data.run
  const maxGens = run?.maxGens ?? 0
  const gen = run?.gen ?? 0
  return {
    run,
    gen,
    maxGens,
    pct: maxGens > 0 ? Math.min(100, Math.round((gen / maxGens) * 100)) : 0,
    lastBeat: data.beats.at(-1)?.at ?? null,
    target: run?.target ?? '-',
    concurrency: run?.concurrency ?? '-',
  }
}

function RunHead({
  data,
  nowMs,
  fetchedAt,
  stale,
}: {
  data: EpicInspectResult
  nowMs: number
  fetchedAt: number | null
  stale: boolean
}) {
  const { run, gen, maxGens, pct, lastBeat, target, concurrency } = headFacts(data)

  return (
    <div className="px-3.5 py-2.5 border-b border-border border-l-[3px] border-l-[color:var(--epic-badge)] bg-[color:var(--epic-badge-tint)] shrink-0">
      <div className="flex items-center gap-2.5">
        <h3 className="text-[15px] font-bold text-foreground truncate">{data.epicId}</h3>
        <StatusPill status={run?.status ?? null} />
        <span className="flex-1" />
        <span className="text-meta text-fg-dim shrink-0">
          target <b className="text-foreground">{target}</b> . concurrency {concurrency}
        </span>
      </div>
      <div className="text-meta text-fg-dim truncate mt-0.5">{data.project}</div>
      <div className="flex items-center gap-2.5 mt-2">
        <span className="text-meta text-muted-foreground shrink-0">GEN {gen}</span>
        <span className="flex-1 h-[3px] bg-border/70">
          <i className="block h-full bg-[color:var(--epic-badge)]" style={{ width: `${pct}%` }} />
        </span>
        <span className="text-meta text-muted-foreground shrink-0">
          of {maxGens} max . beat {ago(lastBeat, nowMs)}
        </span>
        {/* WHEN THIS PANE WAS LAST READ, said out loud. The refresh timer is
            suspended while the tab is hidden and a sleeping machine fires none at
            all, so "beat 11s ago" can itself be an hours-old sentence. Without
            this the pane cannot be distinguished from a live one. */}
        {stale && fetchedAt !== null && (
          <span className="text-meta text-warning shrink-0" title={new Date(fetchedAt).toISOString()}>
            read {ago(new Date(fetchedAt).toISOString(), nowMs)}
          </span>
        )}
      </div>
    </div>
  )
}

function Stats({ data }: { data: EpicInspectResult }) {
  const plan = data.plan
  const done = plan ? plan.children - (plan.dispatch.length + plan.heldBack.length + plan.waitingOnDeps.length) : 0

  return (
    <div className="flex gap-6 px-3.5 py-2.5 border-b border-border shrink-0 flex-wrap">
      <Stat value={Math.max(0, done)} label="DONE" tone="text-active" />
      <Stat value={plan?.dispatch.length ?? 0} label="READY" tone="text-foreground" />
      <Stat value={data.live.inFlight.length} label="IN FLIGHT" tone="text-idle" />
      <Stat value={plan?.waitingOnDeps.length ?? 0} label="BLOCKED" tone="text-fg-dim" />
      <Stat value={data.live.unacknowledged.length} label="UNACKED" tone="text-event-prompt" />
      <Stat value={data.run?.dryGens ?? 0} label="DRY GENS" tone="text-fg-dim" />
    </div>
  )
}

const TAB_BODY: Record<OverseerTab, (d: EpicInspectResult, nowMs: number) => React.ReactNode> = {
  baton: (d, nowMs) => <OverseerBaton baton={d.baton} nowMs={nowMs} />,
  beats: (d, nowMs) => <OverseerBeats beats={d.beats} nowMs={nowMs} />,
  digest: d => <OverseerDigest run={d.run} />,
}

export function OverseerDetail({
  data,
  error,
  loading,
  nowMs,
  onRefresh,
  fetchedAt = null,
  stale = false,
}: {
  data: EpicInspectResult | null
  error: string | null
  loading: boolean
  nowMs: number
  onRefresh: () => void
  /** When the displayed snapshot was fetched, and whether that is old enough to
   *  say so. See use-overseer-inspect.ts for why an open pane can go stale. */
  fetchedAt?: number | null
  stale?: boolean
}) {
  const [tab, setTab] = useState<OverseerTab>('baton')
  const selectConversation = useConversationsStore(s => s.selectConversation)

  if (loading) return <Empty>Reading the run...</Empty>
  if (error && !data) return <Empty>Could not read this run: {error}</Empty>
  if (!data) return <Empty>Pick a run on the left.</Empty>

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      <RunHead data={data} nowMs={nowMs} fetchedAt={fetchedAt} stale={stale} />
      <OverseerControls
        project={data.project}
        epicId={data.epicId}
        run={data.run}
        leaseHeld={Boolean(data.lease?.convId)}
        onDone={onRefresh}
      />
      <Stats data={data} />
      {data.error && <div className="px-3.5 py-1.5 text-[11px] text-destructive shrink-0">{data.error}</div>}

      <div className="flex-1 min-h-0 flex">
        <div className="w-72 shrink-0 border-r border-border overflow-y-auto">
          <OverseerSeats
            live={data.live}
            concurrency={data.run?.concurrency ?? 3}
            onOpenConversation={selectConversation}
          />
          <OverseerDag plan={data.plan} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <OverseerTabStrip tab={tab} onTab={setTab} batonCount={data.baton.length} beatCount={data.beats.length} />
          <div className="flex-1 min-h-0 overflow-y-auto">{TAB_BODY[tab](data, nowMs)}</div>
        </div>
      </div>
    </section>
  )
}

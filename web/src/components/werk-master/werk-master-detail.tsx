/**
 * The detail pane: one run, in full.
 *
 * Layout mirrors the order you actually ask the questions in -- who is this and
 * how does it stand, what can I do about it, what are the numbers, who is
 * working, what does the DAG think, and only then the logs.
 */

import { beatStale, runVitality } from '@shared/epic-vitality'
import { whenWaitingLine } from '@shared/epic-when'
import type { EpicInspectResult } from '@shared/protocol'
import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { leaseSentence, leaseState } from '@/lib/epic-lease-view'
import { cn } from '@/lib/utils'
import { ago, Empty, Stat, StatusPill } from './werk-master-bits'
import { WerkMasterControls } from './werk-master-controls'
import { WerkMasterDag } from './werk-master-dag'
import { WerkMasterSeats } from './werk-master-seats'
import {
  WerkMasterBaton,
  WerkMasterBeats,
  WerkMasterDigest,
  type WerkMasterTab,
  WerkMasterTabStrip,
} from './werk-master-tabs'

/** Everything the heading DERIVES, in one place. Pulled out of the component
 *  because a header that is 90% `?.` and `??` reads as complicated when the only
 *  complicated thing about it is that a run may not exist yet. */
export function headFacts(data: EpicInspectResult, nowMs: number) {
  const run = data.run
  const maxGens = run?.maxGens ?? 0
  const gen = run?.gen ?? 0
  const lastBeat = data.beats.at(-1)?.at ?? null
  return {
    run,
    gen,
    maxGens,
    pct: maxGens > 0 ? Math.min(100, Math.round((gen / maxGens) * 100)) : 0,
    lastBeat,
    target: run?.target ?? '-',
    concurrency: run?.concurrency ?? '-',
    /**
     * WAITING ON THE CLOCK IS NOT IDLE, and `runVitality` below cannot tell the
     * difference: it reads seats, beats and the armed set, none of which change
     * when a run is armed for 02:00. So the appointment is carried BESIDE the
     * pill rather than folded into it -- the same shape the wall's run row uses,
     * and the same reason: a gate that reported "ARMED, waiting for its first
     * beat" for four hours is a pane that cannot be told apart from a dead one.
     *
     * Computed from `run.cadence`, which already crosses on the snapshot, so this
     * needs no wire field and cannot disagree with the beat holding the run.
     */
    waiting: whenWaitingLine(run?.cadence, nowMs),
    // THE SAME derivation the header badge and the wall use, fed from the inspect
    // read instead of the activity feed. One function, three surfaces -- see
    // src/shared/epic-vitality.ts for the lie it was written to stop.
    vitality: runVitality({
      status: run?.status ?? null,
      inFlight: data.live.inFlight.length,
      werkMasterAlive: data.live.werkMasterAlive,
      armed: data.live.armed,
      lastBeatAt: lastBeat,
      stale: beatStale(lastBeat, nowMs),
    }),
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
  const { gen, maxGens, pct, lastBeat, target, concurrency, vitality, waiting } = headFacts(data, nowMs)
  const lease = leaseState(data.lease, data.live.werkMasterAlive, nowMs)

  return (
    <div className="px-3.5 py-2.5 border-b border-border border-l-[3px] border-l-[color:var(--epic-badge)] bg-[color:var(--epic-badge-tint)] shrink-0">
      <div className="flex items-center gap-2.5">
        <h3 className="text-[15px] font-bold text-foreground truncate">{data.epicId}</h3>
        <StatusPill view={vitality} />
        <span className="flex-1" />
        <span className="text-meta text-fg-dim shrink-0">
          target <b className="text-foreground">{target}</b> . concurrency {concurrency}
        </span>
      </div>
      <div className="text-meta text-fg-dim truncate mt-0.5">{data.project}</div>
      {/* THE PILL'S OWN JUSTIFICATION, always printed. "So I can see what the
          fuck is going on" -- a one-word state with no reason is what let RUNNING
          stand over a run that had spawned nothing for hours. */}
      <div
        className={cn('text-meta mt-1', vitality.vitality === 'stalled' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {vitality.why}
      </div>
      {/* THE APPOINTMENT, when there is one still ahead. Directly under the
          vitality sentence because it CONTRADICTS it: the pill says ARMED or
          IDLE and means it, and this is the reason that is the whole story. */}
      {waiting && <div className="text-meta mt-0.5 text-warning">{`WAITING -- ${waiting}`}</div>}
      {/* WHO HOLDS THE LEASE, AND AT WHICH GENERATION. This window used to
          collapse the whole lease to a boolean and show live werk-master
          CONVERSATIONS beside it -- a different fact, which the engine keeps
          apart and the panel did not. On 2026-08-20 the lease named 0dc1e780 at
          gen 11 with no live conversation, which IS the explanation of the
          deadlock, and the only place it was legible was the card file.

          The never-taken case is left to the seats block below, which already
          says it at the volume it deserves; saying it twice in one pane is how a
          heading stops being read. */}
      {lease.kind !== 'never' && (
        <div className={cn('text-meta mt-0.5', lease.kind === 'stale' ? 'text-destructive' : 'text-fg-dim')}>
          {leaseSentence(lease)}
        </div>
      )}
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
  // THREE OF THESE SIX COME OFF THE BOARD, and a board that was never read has
  // no count to give. `0 DONE . 0 READY . 0 BLOCKED` next to two live seats is a
  // reading, and it is the reading that says the run has nothing left to do.
  const unknown = Boolean(data.boardError)
  const fromBoard = (n: number) => (unknown ? '-' : n)

  return (
    <div className="flex gap-6 px-3.5 py-2.5 border-b border-border shrink-0 flex-wrap">
      <Stat value={fromBoard(Math.max(0, done))} label="DONE" tone="text-active" />
      <Stat value={fromBoard(plan?.dispatch.length ?? 0)} label="READY" tone="text-foreground" />
      <Stat value={data.live.inFlight.length} label="IN FLIGHT" tone="text-idle" />
      <Stat value={fromBoard(plan?.waitingOnDeps.length ?? 0)} label="BLOCKED" tone="text-fg-dim" />
      <Stat value={data.live.unacknowledged.length} label="UNACKED" tone="text-event-prompt" />
      <Stat value={data.run?.dryGens ?? 0} label="DRY GENS" tone="text-fg-dim" />
    </div>
  )
}

const TAB_BODY: Record<WerkMasterTab, (d: EpicInspectResult, nowMs: number) => React.ReactNode> = {
  baton: (d, nowMs) => <WerkMasterBaton baton={d.baton} nowMs={nowMs} />,
  beats: (d, nowMs) => <WerkMasterBeats beats={d.beats} nowMs={nowMs} />,
  digest: d => <WerkMasterDigest run={d.run} />,
}

export function WerkMasterDetail({
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
   *  say so. See use-werk-master-inspect.ts for why an open pane can go stale. */
  fetchedAt?: number | null
  stale?: boolean
}) {
  const [tab, setTab] = useState<WerkMasterTab>('baton')
  const selectConversation = useConversationsStore(s => s.selectConversation)

  if (loading) return <Empty>Reading the run...</Empty>
  if (error && !data) return <Empty>Could not read this run: {error}</Empty>
  if (!data) return <Empty>Pick a run on the left.</Empty>

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      <RunHead data={data} nowMs={nowMs} fetchedAt={fetchedAt} stale={stale} />
      <WerkMasterControls
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
          <WerkMasterSeats
            live={data.live}
            concurrency={data.run?.concurrency ?? 3}
            onOpenConversation={selectConversation}
          />
          <WerkMasterDag plan={data.plan} boardError={data.boardError} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <WerkMasterTabStrip tab={tab} onTab={setTab} batonCount={data.baton.length} beatCount={data.beats.length} />
          <div className="flex-1 min-h-0 overflow-y-auto">{TAB_BODY[tab](data, nowMs)}</div>
        </div>
      </div>
    </section>
  )
}

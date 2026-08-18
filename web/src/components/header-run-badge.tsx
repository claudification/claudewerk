/**
 * THE HEADER RUN BADGE -- "is anything running", answered without being asked.
 *
 * The complaint this exists for, verbatim: a live epic run with two working
 * seats was completely invisible. The engine dispatched, beat, and logged, and
 * the panel showed nothing anywhere -- the only control was a 10px button three
 * clicks deep inside the board's epic detail pane, which you had to already know
 * about to find.
 *
 * THE PIP BREATHES ONLY WHILE THE SWEEP IS BEATING. A stalled engine that still
 * animates is the exact lie the whole surface exists to stop telling, so
 * `stale` (computed broker-side, two ticks) freezes it. The badge renders even
 * when nothing is running, dimmed: discoverability was half the original
 * problem, and a control that only appears once you already have a run is a
 * control you never learn exists.
 */

import { useEffect } from 'react'
import { openOverseer } from '@/components/overseer/overseer-state'
import {
  selectAllStale,
  selectLiveCount,
  selectMinGen,
  selectSeatCount,
  useOverseerActivityStore,
} from '@/hooks/use-overseer-activity'
import { cn, haptic } from '@/lib/utils'

function Pip({ live, stale }: { live: boolean; stale: boolean }) {
  return (
    <span
      className={cn(
        'size-1.5 rounded-full shrink-0',
        live ? 'bg-[color:var(--epic-badge)]' : 'bg-muted-foreground/40',
        // Breathing is a claim that the engine is moving. Only make it when true.
        live && !stale && 'animate-[breathe_1.9s_ease-in-out_infinite]',
      )}
    />
  )
}

/** The tooltip, which is where the honest detail goes. Extracted because three
 *  nested conditionals inside a `title=` prop is unreadable in JSX. */
function tooltip(runs: number, seats: number, stale: boolean): string {
  if (runs === 0) return 'Nothing is running. Click to open the overseer and see recent runs.'
  const s = (n: number) => (n === 1 ? '' : 's')
  const head = `${runs} unattended run${s(runs)}, ${seats} seat${s(seats)} working`
  return stale
    ? `${head}. The sweep has gone quiet -- nothing has beaten in over 90s.`
    : `${head}. Click to open the overseer.`
}

function LiveLabel({ runs, seats, gen, stale }: { runs: number; seats: number; gen: number; stale: boolean }) {
  return (
    <>
      <b className="font-bold">
        {runs} RUN{runs === 1 ? '' : 'S'}
      </b>
      <span className="text-muted-foreground/45">.</span>
      <span>gen {gen}</span>
      <span className="text-muted-foreground/45">.</span>
      <span>
        {seats} seat{seats === 1 ? '' : 's'}
      </span>
      {stale && <span className="text-destructive ml-0.5">stalled</span>}
    </>
  )
}

export function HeaderRunBadge() {
  // Four SCALAR subscriptions, not one object selector: returning a fresh object
  // literal from a Zustand selector is the React #185 footgun this codebase has
  // already been bitten by.
  const runs = useOverseerActivityStore(selectLiveCount)
  const seats = useOverseerActivityStore(selectSeatCount)
  const gen = useOverseerActivityStore(selectMinGen)
  const stale = useOverseerActivityStore(selectAllStale)
  const prime = useOverseerActivityStore(s => s.prime)

  // ONE http read, on mount. A tab opened mid-run must not sit blank until the
  // next 45s tick; after this the push channel owns the state.
  useEffect(() => {
    void prime()
  }, [prime])

  const live = runs > 0

  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        openOverseer()
      }}
      title={tooltip(runs, seats, stale)}
      aria-label={live ? `${runs} runs live, open the overseer` : 'Open the overseer'}
      className={cn(
        'shrink-0 flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono border transition-colors',
        live
          ? 'border-[color:var(--epic-badge-edge)] bg-[color:var(--epic-badge-tint)] text-foreground hover:bg-[color:var(--epic-badge-hover)]'
          : 'border-border/45 text-muted-foreground/50 hover:text-muted-foreground hover:border-border',
      )}
    >
      <Pip live={live} stale={stale} />
      {live ? <LiveLabel runs={runs} seats={seats} gen={gen} stale={stale} /> : <span>NO RUNS</span>}
    </button>
  )
}

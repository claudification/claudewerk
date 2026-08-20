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
  selectLiveCount,
  selectMinGen,
  selectSeatCount,
  selectWorkingCount,
  selectWorstLabel,
  useOverseerActivityStore,
} from '@/hooks/use-overseer-activity'
import { cn, haptic } from '@/lib/utils'

function Pip({ live, working }: { live: boolean; working: boolean }) {
  return (
    <span
      className={cn(
        'size-1.5 rounded-full shrink-0',
        live ? 'bg-[color:var(--epic-badge)]' : 'bg-muted-foreground/40',
        // Breathing is a claim that the engine is moving. Only make it when true
        // -- and "moving" means a SEAT is working, not that a status field says
        // `running` (the 2026-08-20 lie: beating every 45s, spawning nobody).
        working && 'animate-[breathe_1.9s_ease-in-out_infinite]',
      )}
    />
  )
}

/** The tooltip, which is where the honest detail goes. Extracted because three
 *  nested conditionals inside a `title=` prop is unreadable in JSX. */
function plural(n: number): string {
  return n === 1 ? '' : 's'
}

function tooltip(runs: number, seats: number, word: string): string {
  if (runs === 0) return 'Nothing is running. Click to open the overseer and see recent runs.'
  return (
    `${runs} unattended run${plural(runs)} (${word.toLowerCase()}), ${seats} seat${plural(seats)} working. ` +
    'Click to open the overseer.'
  )
}

/** The one word that earns a colour. Everything else stays the badge's own ink:
 *  a label that highlights every state highlights none of them. */
const WORD_TONE: Record<string, string> = { STALLED: 'text-destructive', RUNNING: 'text-active' }

/** `word` is the DERIVED state (RUNNING / IDLE / STALLED / ARMED), never the raw
 *  status field. The seat count sits next to it so the claim is checkable at a
 *  glance: "RUNNING . 0 seats" is a contradiction the badge must never print. */
function LiveLabel({ runs, seats, gen, word }: { runs: number; seats: number; gen: number; word: string }) {
  return (
    <>
      <b className="font-bold">
        {runs} RUN{plural(runs).toUpperCase()}
      </b>
      <span className="text-fg-dim">.</span>
      <span>gen {gen}</span>
      <span className="text-fg-dim">.</span>
      <span>
        {seats} seat{plural(seats)}
      </span>
      <span className="text-fg-dim">.</span>
      <span className={WORD_TONE[word]}>{word.toLowerCase()}</span>
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
  const working = useOverseerActivityStore(selectWorkingCount)
  const word = useOverseerActivityStore(selectWorstLabel)
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
      title={tooltip(runs, seats, word)}
      aria-label={live ? `${runs} runs live, open the overseer` : 'Open the overseer'}
      className={cn(
        'shrink-0 flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono border transition-colors',
        live
          ? 'border-[color:var(--epic-badge-edge)] bg-[color:var(--epic-badge-tint)] text-foreground hover:bg-[color:var(--epic-badge-hover)]'
          : 'border-border text-fg-dim hover:text-muted-foreground hover:border-border',
      )}
    >
      <Pip live={live} working={working > 0} />
      {live ? <LiveLabel runs={runs} seats={seats} gen={gen} word={word} /> : <span>NO RUNS</span>}
    </button>
  )
}

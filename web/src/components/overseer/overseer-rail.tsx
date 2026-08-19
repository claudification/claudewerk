/**
 * The run rail -- every run the broker can see, live ones first.
 *
 * A settled run STAYS in the rail. The moment you most want to read a run is
 * just after it completed or aborted, and a list that drops a run the instant it
 * stops is a list that deletes the post-mortem exactly when it becomes
 * interesting (the same reasoning as the beat ring having no `forget`).
 */

import type { EpicActivityEntry } from '@shared/protocol'
import { isLiveRun, selectAllRuns, useOverseerActivityStore } from '@/hooks/use-overseer-activity'
import { cn, haptic } from '@/lib/utils'
import { projectTail } from './overseer-bits'
import { runKey, useOverseerSelection } from './overseer-state'

/** What a rail row DISPLAYS, derived once. Same reasoning as `headFacts`: the
 *  row is not complicated, it just has a lot of optional numbers. */
export function rowFacts(run: EpicActivityEntry) {
  const live = isLiveRun(run)
  return {
    live,
    pct: run.maxGens > 0 ? Math.min(100, Math.round((run.gen / run.maxGens) * 100)) : 0,
    status: run.status ?? 'no run',
    gens: run.maxGens > 0 ? `gen ${run.gen}/${run.maxGens}` : `gen ${run.gen}`,
    flight: run.inFlight > 0 ? ` . ${run.inFlight} in flight` : '',
    /** Only a LIVE run can look stalled -- a paused one is quiet on purpose. */
    stalled: run.stale && live,
  }
}

function Row({ run, selected, onPick }: { run: EpicActivityEntry; selected: boolean; onPick: () => void }) {
  const { live, pct, status, gens, flight, stalled } = rowFacts(run)

  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onPick()
      }}
      className={cn(
        'w-full text-left px-2.5 py-2 border-l-[3px] border-b border-border-subtle transition-colors',
        selected
          ? 'border-l-[color:var(--epic-badge)] bg-[color:var(--epic-badge-tint)]'
          : 'border-l-transparent hover:bg-muted/20',
      )}
    >
      <div className={cn('text-[11px] truncate', live ? 'text-foreground' : 'text-fg-dim')}>
        {run.epicId}
      </div>
      <div className="text-meta text-fg-dim truncate mt-0.5">
        {projectTail(run.project)} . {run.status ?? 'no run'} . gen {run.gen}
        {run.maxGens > 0 && `/${run.maxGens}`}
        {run.inFlight > 0 && ` . ${run.inFlight} in flight`}
      </div>
      <div className="h-0.5 bg-border/60 mt-1.5">
        <i
          className={cn('block h-full', live ? 'bg-[color:var(--epic-badge)]' : 'bg-muted-foreground/35')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {run.stale && live && <div className="text-meta text-destructive mt-1">sweep quiet &gt;90s</div>}
    </button>
  )
}

export function OverseerRail() {
  const runs = useOverseerActivityStore(selectAllRuns)
  const selected = useOverseerSelection(s => s.selected)
  const select = useOverseerSelection(s => s.select)

  // Live first, then by name. A rail that mixed them by project alone would bury
  // the one thing actually happening under five finished runs.
  const ordered = [...runs].sort(
    (a, b) => Number(isLiveRun(b)) - Number(isLiveRun(a)) || a.epicId.localeCompare(b.epicId),
  )
  const liveCount = ordered.filter(isLiveRun).length

  return (
    <aside className="w-52 shrink-0 border-r border-border overflow-y-auto bg-muted/10">
      <div className="px-2.5 py-2 text-chrome uppercase text-fg-dim flex justify-between">
        <span>Runs</span>
        <span>
          {liveCount}/{ordered.length}
        </span>
      </div>
      {ordered.length === 0 ? (
        <div className="px-2.5 py-4 text-[11px] text-fg-dim italic">
          Nothing has run yet. Arm one from a board epic's RUN button.
        </div>
      ) : (
        ordered.map(run => (
          <Row
            key={runKey(run.project, run.epicId)}
            run={run}
            selected={selected === runKey(run.project, run.epicId)}
            onPick={() => select(run.project, run.epicId)}
          />
        ))
      )}
    </aside>
  )
}

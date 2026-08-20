/**
 * A6 SHEAF -- the structural ledger: where the money and the conversation TREES
 * went.
 *
 * Feed: `GET /api/sheaf?windowH=N` (admin-gated, visibility-filtered), compacted
 * by `summarizeSheaf()` -- the SAME function the dispatcher's `fleet_sheaf` tool
 * calls, imported from `@shared/sheaf-summary`. The rollup maths is not repeated
 * here and there is no second route; see `use-wall-sheaf.ts` for why one fetch
 * serves this pane and A4.
 *
 * The window label comes off the RESPONSE, not off the selected tab, so numbers
 * mid-switch are always labelled with the window they were built for.
 *
 * FILTER: `text` and `project`, plus `$cost` -- a sheaf row is money, so `$5`
 * meaning "projects that burned at least five dollars" is the one extra axis
 * this pane genuinely understands. No `~time` (the tabs ARE the window) and no
 * band/context/model (a project is not a conversation).
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useWallFilter, type WallAxis } from '@/lib/wall/filter'
import { type SheafRow, type SheafView, sheafView, sheafWindowLabel } from '@/lib/wall/sheaf-rows'
import { sheafReport } from '@/lib/wall/stat-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { useProjectLook } from '../use-project-look'
import { SHEAF_WINDOWS, type SheafWindow, useWallSheafFeed, useWallSheafStore } from '../use-wall-sheaf'
import { handleChipCapture } from '../wall-chip-capture'
import { WallPane } from '../wall-pane'
import { SheafRowView } from './sheaf-row'

const AXES: readonly WallAxis[] = ['text', 'project', 'cost']

/** Stable empty identity -- the filter memo keys on the array. */
const NO_ROWS: readonly SheafRow[] = []

/** The four ways this pane can have nothing to draw, told apart. */
function emptyLine(error: string | null, loaded: boolean, total: number): string {
  if (error) return `sheaf unavailable: ${error}`
  if (!loaded) return 'loading the ledger…'
  return total === 0 ? 'nothing spent in this window' : 'no project matches the filter'
}

function WindowTab({ windowH, current, onPick }: { windowH: SheafWindow; current: number; onPick: () => void }) {
  const on = windowH === current
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={cn(
        'text-[10px] px-[7px] py-[2px] rounded-[3px] border transition-colors',
        on
          ? 'bg-background text-foreground border-primary/25'
          : 'border-transparent text-comment hover:text-foreground',
      )}
    >
      {sheafWindowLabel(windowH)}
    </button>
  )
}

/** The money strip above the rows. Renders nothing until a view exists. */
function SheafTotals({ view, loading }: { view: SheafView | null; loading: boolean }) {
  if (!view) return null
  return (
    <div className="wall-sheaf-totals">
      <span>
        <b>${view.totals.costUsd.toFixed(2)}</b> spent
      </span>
      <span>
        <b>{view.totals.conversations}</b> conversations
      </span>
      <span>
        <b>{view.totals.trees}</b> spawn trees
      </span>
      <span className="wall-sheaf-window">
        {sheafWindowLabel(view.windowH)} window{loading && ' · refreshing'}
      </span>
    </div>
  )
}

/**
 * COUNTED, NEVER SILENT -- the three lines under the rows are one rule, so they
 * live in one component: a project that is not drawn still gets said out loud.
 * `clipped` was too cheap to fit, `quiet` had nothing to report, and the empty
 * line names which of the four nothings this is.
 */
function SheafFooters({
  view,
  rowCount,
  error,
  total,
}: {
  view: SheafView | null
  rowCount: number
  error: string | null
  total: number
}) {
  return (
    <>
      {view && view.clipped > 0 && (
        <p className="wall-sheaf-clipped" title="The summariser keeps the top projects by cost">
          + {view.clipped} lower-cost project{view.clipped === 1 ? '' : 's'} clipped
        </p>
      )}
      {/* Jonas asked for less noise, not for projects to vanish without trace. */}
      {view && view.quiet > 0 && (
        <p
          className="wall-sheaf-clipped"
          title="Projects with nothing to report in this window: no live conversation, no spend, no git alert, no unmerged commit"
        >
          + {view.quiet} quiet
        </p>
      )}
      {rowCount === 0 && (
        <p className="text-meta text-fg-faint px-0.5 py-1">{emptyLine(error, view !== null, total)}</p>
      )}
    </>
  )
}

export default function SheafPane() {
  const { stale } = useWallSheafFeed()
  const data = useWallSheafStore(s => s.data)
  const loading = useWallSheafStore(s => s.loading)
  const error = useWallSheafStore(s => s.error)
  const selected = useWallSheafStore(s => s.windowH)
  const setWindow = useWallSheafStore(s => s.setWindow)
  const look = useProjectLook()

  const view = useMemo(() => (data ? sheafView(data, look) : null), [data, look])
  const { rows, matched, total } = useWallFilter(view?.rows ?? NO_ROWS, AXES, r => ({
    title: r.projectName,
    project: r.projectName,
    costUsd: r.costUsd,
  }))
  const reportView = useWallReportView()

  return (
    <WallPane
      title="SHEAF"
      code="A6"
      count={`${matched}/${total}`}
      stale={stale}
      report={() => sheafReport(view, rows, reportView)}
      tabs={
        <div className="flex gap-[2px]">
          {SHEAF_WINDOWS.map(w => (
            <WindowTab key={w} windowH={w} current={selected} onPick={() => setWindow(w)} />
          ))}
        </div>
      }
    >
      <SheafTotals view={view} loading={loading} />
      {/* Capture-phase, like every other pane: the chip scopes the wall through
          the filter store's own action and never through a handler in here. */}
      <div onClickCapture={handleChipCapture}>
        {rows.map(row => (
          <SheafRowView key={row.projectUri} row={row} />
        ))}
      </div>
      <SheafFooters view={view} rowCount={rows.length} error={error} total={total} />
    </WallPane>
  )
}

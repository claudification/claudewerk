/**
 * A2 BURN -- the burn clock. What the fleet is costing, and against what ceiling.
 *
 * FOUR NUMBERS, FOUR REAL FEEDS. The live rate folds `WallPulseRow.costUsd`
 * deltas off the wall channel (`lib/wall/burn.ts`); TODAY and the per-project
 * split fold `/api/stats/hourly`; 30D is `/api/stats/summary`; the OpenRouter
 * split is `/api/stats/openrouter`, which `wall-openrouter-spend-store` made
 * queryable. Nothing here is computed from a price table or a guess -- a feed
 * that did not arrive renders `--`.
 *
 * THE PERIOD MOVES THE SPLITS AND NOTHING ELSE. `WallPeriodTabs` writes the
 * wall's one period field (`lib/wall/period-store.ts`) and both splits re-read at
 * it: PROJECTS through `/api/stats/hourly?from=`, OPENROUTER through
 * `/api/stats/openrouter?period=`. Each still folds its OWN rows into its OWN
 * total under every period -- the selector re-scopes two splits, it does not
 * introduce a third number that spans them.
 *
 * THE TILES DO NOT FOLLOW THE PERIOD, ON PURPOSE. TODAY is a calendar-day anchor
 * and 30D is the window the CAP is defined over; a monthly ceiling compared
 * against a 1h fold would report 0% and read as safety, which is the precise
 * failure the cap tile exists to prevent. They are the fleet-wide facts (see
 * below) and a period control that silently repurposed them would turn two
 * anchors into two more views of the same thing the bars already show.
 *
 * THE HOURLY FEED HAS A GRAIN AND A CEILING. `hourly_stats` excludes the hour in
 * progress, so `1h` is the last COMPLETE hour and the split says so beside its
 * window label rather than in a tooltip. The other end is the retention bound:
 * both cost stores prune at 30 days, which is why `1m` (= 30d, not a calendar
 * month) is the longest period offered and nothing longer may be added.
 *
 * THE TWO SPLITS ARE NEVER SUMMED. Per-project spend is work done FOR something;
 * OpenRouter spend is the panel's own infrastructure. They carry separate totals
 * and separate shares all the way down (`burn-splits.ts`), and they even cover
 * their windows separately in the header, so no glance can read them as one bar
 * chart of one quantity.
 *
 * THE TILES ARE FLEET-WIDE ON PURPOSE. Typing `@anvil` narrows the splits and the
 * count, and leaves TODAY / 30D / the cap alone: a spend ceiling is a fact about
 * the whole fleet, and a cap that changed when you filtered would be worthless as
 * an alarm.
 *
 * FILTER. The project split declares `text`, `project`, `workspace` and `cost`
 * -- the axes a project bar actually has a facet for, `workspace` included
 * because it is resolved FROM the project name and needs nothing else from the
 * bar. The OpenRouter split declares
 * `text` only, so `@anvil` leaves it FULL rather than empty: a broker feature is
 * not attributable to a project, and blanking it would assert that it is.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useMemo } from 'react'
import { ProjectTag } from '@/components/project-tag'
import { useBurnFeed } from '@/hooks/use-burn-feed'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectDisplayName } from '@/lib/utils'
import {
  type BurnBar,
  capState,
  costSince,
  featureSplit,
  projectSplit,
  restrictSplit,
  startOfHour,
  startOfLocalDay,
} from '@/lib/wall/burn-splits'
import { useWallFilter, useWallFilterStore, type WallAxis } from '@/lib/wall/filter'
import { useWallPeriodStore, WALL_PERIOD_MS, type WallPeriod } from '@/lib/wall/period-store'
import { burnReport } from '@/lib/wall/stat-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { BurnBars } from '../burn/burn-bars'
import { BURN_RATE_READING, BurnLive } from '../burn/burn-live'
import { BurnTiles } from '../burn/burn-tiles'
import { WallPane } from '../wall-pane'
import { WallPeriodTabs } from '../wall-period-tabs'
import { wallReading } from '../wall-reading-bus'

const PROJECT_AXES: readonly WallAxis[] = ['text', 'project', 'workspace', 'cost']
const FEATURE_AXES: readonly WallAxis[] = ['text']

/**
 * What the PROJECT split's window label leaves out, when it leaves anything out.
 *
 * Only `1h` needs one. Hourly buckets exclude the hour in progress, so a 1h ask
 * returns exactly one finished bucket -- true for every period, but only at 1h is
 * the missing part the whole of what a reader assumes they are looking at. The
 * OpenRouter split gets no note at any period: its rows carry real per-call
 * timestamps, so its window is the literal trailing one.
 */
function projectWindowNote(period: WallPeriod): string | undefined {
  return period === '1h' ? '(last complete hour)' : undefined
}

/** Why a split is empty -- three different facts that would otherwise wear one
 *  shape: the feed never arrived, the window is genuinely quiet, or the filter
 *  took everything. Only the middle one is good news. */
function emptyReason(fed: boolean, hadAny: boolean, feedNoun: string, rowNoun: string, window: string): string {
  if (!fed) return `no ${feedNoun} feed`
  return hadAny ? `no ${rowNoun} matches the filter` : `nothing billed in ${window}`
}

export default function BurnPane() {
  const period = useWallPeriodStore(s => s.period)
  const feed = useBurnFeed(period)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const capUsd = useConversationsStore(s => s.globalSettings.monthlySpendCapUsd as number | undefined)

  const model = useMemo(() => {
    const rows = feed.hourly ?? []
    const settings = (uri: string) => projectSettings[projectIdentityKey(uri)]
    const now = Date.now()
    // TWO WINDOWS OVER ONE ROW SET, and that is why `projectSplit` takes a
    // `sinceMs` at all. The pull covers the period OR the calendar day, whichever
    // reaches further back (`burnHourlyFrom`), so the split has to snap its own
    // edge here -- handing it `0` would have `1h` quietly render every row the
    // TODAY tile needed.
    const since = startOfHour(now - WALL_PERIOD_MS[period])
    return {
      projects: projectSplit(rows, since, uri => projectDisplayName(uri, settings(uri)?.label)),
      features: featureSplit(feed.features ?? []),
      todayUsd: feed.hourly ? costSince(rows, startOfLocalDay(now)) : null,
      // The unattributed bucket has no URI and therefore no settings entry -- it
      // gets the plain label rather than some other project's icon.
      look: (uri: string) => (uri ? { icon: settings(uri)?.icon, color: settings(uri)?.color } : {}),
    }
  }, [feed.hourly, feed.features, projectSettings, period])

  const projects = useWallFilter(model.projects.bars, PROJECT_AXES, bar => ({
    title: bar.label,
    project: bar.label,
    costUsd: bar.costUsd,
  }))
  const features = useWallFilter(model.features.bars, FEATURE_AXES, bar => ({ title: bar.label }))

  /** THE CHIP ACTION -- the store's, not a local one. Exactly one implementation
   *  of "scope to this project, or clear it if it is already the scope" exists in
   *  this tree and it is not in this file. */
  const pickProject = (bar: BurnBar) => useWallFilterStore.getState().toggleProject(bar.label)

  const view = useWallReportView()
  const cap = capState(capUsd, feed.monthUsd ?? 0)
  /** Read at CLICK time, not at render: `BurnLive` republishes the rate every
   *  second and the pane must not re-render with it. */
  const report = () =>
    burnReport(
      {
        rate: wallReading(BURN_RATE_READING)?.value ?? '--',
        todayUsd: model.todayUsd,
        monthUsd: feed.monthUsd,
        cap,
        projects: restrictSplit(projects.rows),
        features: restrictSplit(features.rows),
        window: period,
      },
      view,
    )

  return (
    <WallPane
      title="BURN"
      code="A2"
      count={`${projects.matched}/${projects.total} · ${period}`}
      tabs={<WallPeriodTabs />}
      stale={feed.stale}
      report={report}
    >
      <div className="wall-burn">
        <BurnLive />
        <BurnTiles todayUsd={model.todayUsd} monthUsd={feed.monthUsd} cap={cap} />
        <BurnBars
          title="PROJECTS"
          window={period}
          note={projectWindowNote(period)}
          split={restrictSplit(projects.rows)}
          empty={emptyReason(feed.hourly !== null, projects.total > 0, 'cost', 'project', period)}
          onPick={pickProject}
          tag={bar => <ProjectTag name={bar.label} {...model.look(bar.key)} />}
        />
        <BurnBars
          title="OPENROUTER"
          window={period}
          split={restrictSplit(features.rows)}
          empty={emptyReason(feed.features !== null, features.total > 0, 'openrouter', 'feature', period)}
        />
      </div>
    </WallPane>
  )
}

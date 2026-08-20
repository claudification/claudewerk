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
 * FILTER. The project split declares `text`, `project` and `cost` -- the three
 * axes a project bar actually has a facet for. The OpenRouter split declares
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
  startOfLocalDay,
} from '@/lib/wall/burn-splits'
import { useWallFilter, useWallFilterStore, type WallAxis } from '@/lib/wall/filter'
import { burnReport } from '@/lib/wall/stat-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { BurnBars } from '../burn/burn-bars'
import { BURN_RATE_READING, BurnLive } from '../burn/burn-live'
import { BurnTiles } from '../burn/burn-tiles'
import { WallPane } from '../wall-pane'
import { wallReading } from '../wall-reading-bus'

const PROJECT_AXES: readonly WallAxis[] = ['text', 'project', 'cost']
const FEATURE_AXES: readonly WallAxis[] = ['text']
const WINDOW = '24h'

/** Why a split is empty -- three different facts that would otherwise wear one
 *  shape: the feed never arrived, the window is genuinely quiet, or the filter
 *  took everything. Only the middle one is good news. */
function emptyReason(fed: boolean, hadAny: boolean, feedNoun: string, rowNoun: string): string {
  if (!fed) return `no ${feedNoun} feed`
  return hadAny ? `no ${rowNoun} matches the filter` : `nothing billed in ${WINDOW}`
}

export default function BurnPane() {
  const feed = useBurnFeed()
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const capUsd = useConversationsStore(s => s.globalSettings.monthlySpendCapUsd as number | undefined)

  const model = useMemo(() => {
    const rows = feed.hourly ?? []
    const settings = (uri: string) => projectSettings[projectIdentityKey(uri)]
    const now = Date.now()
    return {
      projects: projectSplit(rows, 0, uri => projectDisplayName(uri, settings(uri)?.label)),
      features: featureSplit(feed.features ?? []),
      todayUsd: feed.hourly ? costSince(rows, startOfLocalDay(now)) : null,
      // The unattributed bucket has no URI and therefore no settings entry -- it
      // gets the plain label rather than some other project's icon.
      look: (uri: string) => (uri ? { icon: settings(uri)?.icon, color: settings(uri)?.color } : {}),
    }
  }, [feed.hourly, feed.features, projectSettings])

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
        window: WINDOW,
      },
      view,
    )

  return (
    <WallPane
      title="BURN"
      code="A2"
      count={`${projects.matched}/${projects.total} · ${WINDOW}`}
      stale={feed.stale}
      report={report}
    >
      <div className="wall-burn">
        <BurnLive />
        <BurnTiles todayUsd={model.todayUsd} monthUsd={feed.monthUsd} cap={cap} />
        <BurnBars
          title="PROJECTS"
          window={WINDOW}
          split={restrictSplit(projects.rows)}
          empty={emptyReason(feed.hourly !== null, projects.total > 0, 'cost', 'project')}
          onPick={pickProject}
          tag={bar => <ProjectTag name={bar.label} {...model.look(bar.key)} />}
        />
        <BurnBars
          title="OPENROUTER"
          window={WINDOW}
          split={restrictSplit(features.rows)}
          empty={emptyReason(feed.features !== null, features.total > 0, 'openrouter', 'feature')}
        />
      </div>
    </WallPane>
  )
}

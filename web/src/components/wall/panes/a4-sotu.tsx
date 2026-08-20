/**
 * A4 STATE OF THE UNION -- the prose brief, per project, with the git line
 * underneath it.
 *
 * HIDDEN IN AMBIENT, per the mockup: it is the one pane made of sentences, and
 * nobody reads sentences from across a room.
 *
 * Feed: the SAME `/api/sheaf` response A6 renders (`use-wall-sheaf.ts`). Phase 6
 * folds the SOTU narrative and the git fabric INTO that response, so this pane
 * opens no route of its own -- which is why A6 and A4 are one card.
 *
 * LIVE TEXT, NOT A SNAPSHOT: every sentence here is the narrative as the broker
 * distilled it, stamped with its own age. Nothing in this file is written at
 * build time.
 *
 * SCOPED SERVER-SIDE: the rows are `response.sotu.blocks`, the roster the broker
 * already narrowed to the projects this viewer may see AND whose chronicle is
 * ON. Jonas, 2026-08-20: *"DO NOT SHOW projects that have chronicle off or
 * disabled .. only show relevant information."* A chronicle-off project is not
 * greyed here and not rendered as `no data` -- it is absent, and its name never
 * reaches the roster this pane reads.
 *
 * DEVIATION FROM THE MOCKUP, stated as the epic requires: the mockup's git line
 * carries `disk 99%` and `WAL 10.1 GB` pills. Neither is in this feed -- disk is
 * a host fact that S1 already renders from the node-stats frames, and no
 * publisher for a WAL size exists in the tree at all. The pills rendered here are
 * the ones the SOTU union actually produces.
 *
 * FILTER: `text` and `project`. A chronicle has no cost, no band and no host.
 */

import { useMemo } from 'react'
import { useWallFilter, type WallAxis } from '@/lib/wall/filter'
import { fleetPills, SOTU_NOT_DISTILLED, type SotuBlock, sotuBlocks } from '@/lib/wall/sheaf-rows'
import { sotuReport } from '@/lib/wall/stat-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { ProjectTag } from '../../project-tag'
import { useProjectLook } from '../use-project-look'
import { useWallSheafFeed, useWallSheafStore } from '../use-wall-sheaf'
import { handleChipCapture } from '../wall-chip-capture'
import { WallPane } from '../wall-pane'

const AXES: readonly WallAxis[] = ['text', 'project']

/** Stable empty identity -- the filter memo keys on the array. */
const NO_BLOCKS: readonly SotuBlock[] = []

/** The four ways this pane can have nothing to say, told apart. */
function emptyLine(error: string | null, loaded: boolean, total: number): string {
  if (error) return `state of the union unavailable: ${error}`
  if (!loaded) return 'reading the union…'
  return total === 0 ? 'no project reports a state' : 'no project matches the filter'
}

function chronicleAge(generatedAt: number, now: number): string {
  const mins = Math.max(0, Math.round((now - generatedAt) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function SotuBlockView({ block, now }: { block: SotuBlock; now: number }) {
  return (
    <div className="wall-sotu-block" data-project-uri={block.projectUri}>
      <div className="wall-sotu-head">
        <ProjectTag name={block.projectName} icon={block.projectIcon} color={block.projectColor} />
        {block.alerts.map(a => (
          <span key={a} className="wall-sotu-alert">
            {a}
          </span>
        ))}
        {block.unmerged > 0 && <span className="wall-sotu-warn">{block.unmerged} unmerged</span>}
        {block.contended > 0 && <span className="wall-sotu-alert">{block.contended} contended</span>}
        <span className="flex-1" />
        {block.generatedAt && <span className="wall-sotu-age">{chronicleAge(block.generatedAt, now)}</span>}
      </div>
      {block.narrative ? (
        <p className="wall-sotu-text">{block.narrative}</p>
      ) : (
        <p className="wall-sotu-quiet">{SOTU_NOT_DISTILLED}</p>
      )}
    </div>
  )
}

export default function SotuPane() {
  const { stale } = useWallSheafFeed()
  const data = useWallSheafStore(s => s.data)
  const error = useWallSheafStore(s => s.error)
  const look = useProjectLook()

  const blocks = useMemo(() => (data ? sotuBlocks(data, look) : NO_BLOCKS), [data, look])
  const pills = useMemo(() => fleetPills(data?.sotu), [data])
  const { rows, matched, total } = useWallFilter(blocks, AXES, b => ({
    project: b.projectName,
    title: b.projectName,
    // The prose IS the haystack: you search the union for the word you remember.
    action: b.narrative ?? '',
  }))

  // The response's own stamp, so an age is measured against the data rather than
  // against a clock this pane would have to tick for no other reason.
  const now = data?.generatedAt ?? 0
  const view = useWallReportView()

  return (
    <WallPane
      title="STATE OF THE UNION"
      code="A4"
      hideInAmbient
      count={`${matched}/${total}`}
      stale={stale}
      report={() => sotuReport(pills, rows, view)}
    >
      {pills.length > 0 && (
        <div className="wall-sotu-pills">
          {pills.map(p => (
            <span key={p.key} className="wall-sotu-pill" data-tone={p.tone} title={p.title}>
              {p.label}
            </span>
          ))}
        </div>
      )}
      <div onClickCapture={handleChipCapture}>
        {rows.map(block => (
          <SotuBlockView key={block.projectUri} block={block} now={now} />
        ))}
      </div>
      {rows.length === 0 && (
        <p className="text-meta text-fg-faint px-0.5 py-1">{emptyLine(error, data !== null, total)}</p>
      )}
    </WallPane>
  )
}

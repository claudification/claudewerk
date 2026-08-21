/**
 * The surface's two calls, and the one push it listens for.
 *
 * THERE IS NO `sweep` VERB HERE, and its absence is the design. The surface
 * renders the artifact the schedule already produced; a panel that could ask for
 * a sweep would eventually be made to, and an on-demand report can never
 * visibly fail because it always renders something. A missing brew must be
 * noticeable, so this module can only ever READ one.
 *
 * `board_report_changed` arrives unsolicited when a sweep lands. It is the whole
 * reason this rides the shared router rather than a private request channel: a
 * PARKED surface has to learn the morning's brew arrived, or its dock tile can
 * never pulse.
 */

import type { BoardApplyOutcome, BoardProposalRef, BoardReportRecord } from '@shared/protocol'
import { useConversationsStore } from '@/hooks/use-conversations'
import { createWsRequestChannel } from '@/lib/ws-request'

const channel = createWsRequestChannel('morning report')

/** The last recorded report for a project. `null` means no sweep has ever
 *  landed -- an answer, and the one this feature was built to make visible. */
export async function fetchLatestReport(project: string): Promise<BoardReportRecord | null> {
  const resp = await channel.send({ type: 'board_report_request', project, op: 'latest' })
  return (resp.report as BoardReportRecord | null) ?? null
}

/**
 * Execute the ticked rows against `date`'s report.
 *
 * The BROKER logs the intent, calls `apply`, and logs what came back -- in that
 * order, on its own side of the wire. A tab closed mid-press therefore loses the
 * spinner and nothing else.
 */
export async function executeProposals(
  project: string,
  date: string,
  proposals: BoardProposalRef[],
): Promise<BoardApplyOutcome[]> {
  const resp = await channel.send({
    type: 'board_report_request',
    project,
    op: 'execute',
    execute: { proposals, date },
  })
  return (resp.applied as BoardApplyOutcome[] | undefined) ?? []
}

type Listener = (report: BoardReportRecord) => void

const listeners = new Set<Listener>()
let installed = false

/** Subscribe to fresh brews. Returns the unsubscribe. */
export function onBoardReportChanged(listener: Listener): () => void {
  install()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * One shared router entry for the whole app.
 *
 * Installed lazily and exactly once: the slot in the conversations store is
 * single-valued, so a per-component install would let the last surface to mount
 * silently steal the replies of the first.
 */
function install(): void {
  if (installed) return
  installed = true
  useConversationsStore.setState({
    boardReportHandler: (msg: Record<string, unknown>) => {
      if (msg.type === 'board_report_changed') {
        const report = msg.report as BoardReportRecord | undefined
        if (report) for (const listener of listeners) listener(report)
        return
      }
      channel.settle(msg)
    },
  })
}

/** Test seam: drop the installed router entry so a fresh test file re-installs. */
export function resetBoardReportRouting(): void {
  listeners.clear()
  installed = false
  useConversationsStore.setState({ boardReportHandler: null })
}

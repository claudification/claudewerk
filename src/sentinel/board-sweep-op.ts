/**
 * THE `sweep` BOARD OP -- the morning report, run beside the files.
 *
 * It lives on the SENTINEL for the same reason `promises` does, one step
 * stronger: this one reads the board AND runs git AND writes a file. The broker
 * may do none of the three (CWD IS INFORMATIONAL, `lint:boundary` Rule 4), and
 * `src/shared/board-sweep.ts` is a pure fold that reads nothing at all. This
 * module is the only place the three meet.
 *
 * EAGER, NOT ON-DEMAND. The artifact is produced by the schedule and is already
 * waiting when a human looks. That is the property the whole epic rests on: a
 * panel that computes on open can never visibly fail, because it always renders
 * something. A missing brew must be noticeable, so the file is the deliverable.
 *
 * ORDERING: the report is written BEFORE the proposals go back on the wire, and
 * a failed write is an error rather than a quiet omission. Returning proposals
 * while the artifact silently did not land would produce a broker log that says
 * a report exists when nothing is on disk.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sweepBoard } from '../shared/board-sweep'
import { listProjectTasks } from '../shared/project-card-read'
import { reportPath, reportRelPath, reportsDir } from '../shared/project-paths'
import type { BoardSweepRequest, BoardSweepResult, Conversation } from '../shared/protocol'
import { renderBoardReport, reportDateIn } from './board-sweep-report'
import { gitHead } from './promise-git'
import { scanPromiseLedger } from './promise-scan'

/** Where the previous run's `snapshot` is kept, beside the artifacts it explains.
 *  Dot-prefixed so a directory listing of reports stays a list of reports. */
const STATE_FILE = '.sweep-state.json'

interface SweepState {
  snapshot: string
  /** Purely for a human reading the file -- nothing branches on it. */
  sweptAt?: number
}

function readState(root: string): SweepState | null {
  try {
    const raw = readFileSync(join(reportsDir(root, false), STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as SweepState
    return typeof parsed?.snapshot === 'string' ? parsed : null
  } catch {
    // No state is the honest first-run answer: `lastSnapshot: null` disables the
    // short-circuit, so an unreadable state file costs one full sweep and never
    // costs a wrong one.
    return null
  }
}

function writeState(root: string, state: SweepState): void {
  writeFileSync(join(reportsDir(root), STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * The fold's liveness deps, replayed from the answer the broker already sent.
 *
 * `sweepBoard` asks for liveness the broker's way -- the conversation registry
 * plus `werk-liveness`'s predicate -- because that is where both live. Over here
 * neither exists: the sentinel cannot see a socket. What crossed the wire is the
 * ANSWER (`liveCards`), and this adapter puts it back into the shape
 * `cardsBeingWorked` reads. `launchConfig.epic.cardId` is the only field of a
 * conversation the fold ever touches, which is why the cast is safe and narrow.
 */
function livenessDeps(liveCards: readonly string[]): {
  getAllConversations: () => Conversation[]
  isLive: () => boolean
} {
  const stand = liveCards.map(cardId => ({ launchConfig: { epic: { cardId } } }) as unknown as Conversation)
  return { getAllConversations: () => stand, isLive: () => true }
}

/**
 * Run one sweep and land its artifact.
 *
 * `project` is the canonical URI and is INFORMATIONAL -- it is stamped into the
 * report so a row is an address you can click, and it is never a path. `root`
 * stays the sole path input, as with every other board op.
 */
export async function runBoardSweep(
  root: string,
  project: string,
  req: BoardSweepRequest,
  nowMs: number,
): Promise<BoardSweepResult> {
  const cards = listProjectTasks(root)
  const previous = readState(root)
  const outcome = await sweepBoard({
    ...livenessDeps(req.liveCards),
    log: line => console.log(`[board-sweep] ${line}`),
    now: () => nowMs,
    getCards: () => cards,
    getPromises: () => scanPromiseLedger(root, project, nowMs).rows,
    head: () => gitHead(root),
    lastSnapshot: () => previous?.snapshot ?? null,
    coldAfterDays: req.coldAfterDays,
    // NO `judgeDuplicates`. The fold reports that as `no-duplicate-judge` on
    // every shortlisted pair and the report says so out loud -- "nobody looked"
    // is a different claim from "there are none", and wiring a model call is a
    // separate card.
  })

  const date = reportDateIn(nowMs, req.tz)
  const abs = reportPath(root, date)
  const refused = outcome.refused.map(r => ({ unit: r.unit, bucket: r.bucket as string, detail: r.detail }))

  // A SHORT-CIRCUITED RUN NEVER OVERWRITES AN EXISTING BREW. The second sweep of
  // a quiet day computes nothing, and letting it stamp "nothing moved" over the
  // morning's proposals would destroy the artifact the schedule exists to make.
  // With no file yet, it still writes one: a date with no report must mean the
  // sweep did not run, never "it ran and had nothing to say".
  const leaveAlone = outcome.skipped && existsSync(abs)
  if (!leaveAlone) {
    writeFileSync(
      abs,
      renderBoardReport({
        project,
        date,
        nowMs,
        tz: req.tz,
        proposals: outcome.proposals,
        selected: outcome.selected,
        acted: outcome.acted,
        refused,
        snapshot: outcome.snapshot,
        skipped: outcome.skipped,
        idleReason: outcome.idleReason,
        duplicateJudgeAbsent: refused.some(r => r.bucket === 'no-duplicate-judge'),
      }),
      'utf8',
    )
  }
  writeState(root, { snapshot: outcome.snapshot, sweptAt: nowMs })

  return {
    proposals: [...outcome.proposals],
    snapshot: outcome.snapshot,
    skipped: outcome.skipped,
    selected: [...outcome.selected],
    acted: [...outcome.acted],
    refused,
    idleReason: outcome.idleReason,
    reportDate: date,
    reportPath: reportRelPath(date),
    reportWritten: !leaveAlone,
  }
}

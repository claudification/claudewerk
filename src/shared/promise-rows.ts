/**
 * The promise ledger, as a FOLD over one project's board. No React, no store,
 * no I/O -- the same shape as `pinned-epic-rows.ts`, and for the same reason.
 *
 * IT LIVES IN `shared/` BECAUSE THE SENTINEL RUNS IT. A promise is a nested
 * `promise:` block in a card's FRONT MATTER, and the front matter never crosses
 * the wire: `ProjectTaskMeta` is a fixed projection and `ProjectTask.body` is
 * the text BELOW the closing `---`. So a browser-side fold is not merely
 * expensive here, it is impossible -- there is nothing in the wire shape to
 * fold. The `promises` board op (src/sentinel/project-handlers.ts) runs this
 * beside the files, where the raw bytes are, and sends back only the rows. The
 * browser imports the same module for its types.
 *
 * THE ROW SET IS NOT "EVERY CARD". Sending 372 rows to render a handful would
 * be the boot-payload mistake with extra steps. Two kinds of card are included
 * and the reason differs:
 *
 * - **carries a `promise:` block** -- there is something to report a verdict on.
 * - **FILED (`done` / `archived`)** -- whatever it carries, including nothing.
 *   This is the half that matters. A card filed as finished with no promise at
 *   all is the exact failure the ledger exists to catch, and a fold that only
 *   looked at cards with promise blocks would be structurally blind to it: the
 *   70-odd cards THE WALL closed carry no block, so they would vanish from the
 *   one table built to name them.
 *
 * Everything else -- an open card with no promise -- is `not-started` by
 * definition and needs no row to say so. `scanned` reports the denominator so
 * a consumer can never mistake the row set for the board.
 */

import { parseFrontmatter } from './frontmatter'
import {
  type CommitResolver,
  closedWithoutCommit,
  type PromiseRow,
  parsePromiseBlock,
  verdictFor,
} from './promise-ledger'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'

/** One card as the fold needs it: its id and its RAW TEXT, front matter and all. */
export interface PromiseCard {
  id: string
  text: string
}

/**
 * What one project's fold returns.
 *
 * `resolverBase` is not decoration. A verdict of `could not verify` has two very
 * different causes -- a sha git has never heard of vs. no main branch to compare
 * anything against -- and a surface that cannot tell them apart renders the same
 * grey pill for "this repo has no main" as for "this one commit is unreachable".
 * Null here means EVERY verdict on this project is unverifiable and the reason is
 * the repo, not the promises.
 */
export interface PromiseLedger {
  /** Canonical project URI. The rows are addresses you click, like `pinned`. */
  project: string
  rows: PromiseRow[]
  /** Cards on the board, INCLUDING the ones no row was emitted for. */
  scanned: number
  /** The ref every `onMain` answer was taken against (`main`, `master`), or null
   *  when the resolver had no base -- see the note above. */
  resolverBase: string | null
  /** A timestamped snapshot, same covenant as the git fabric: a verdict is only
   *  true as of when git was asked. */
  scannedAt: number
}

const FILED: ReadonlySet<string> = new Set<TaskStatus>(['done', 'archived'])

function asStatus(v: unknown): TaskStatus | null {
  return (TASK_STATUSES as readonly string[]).includes(String(v)) ? (String(v) as TaskStatus) : null
}

/**
 * One card -> one row, or null when the card has nothing to report.
 *
 * The empty promise block for a filed card with no `promise:` is deliberate and
 * is the whole trick: `closes: []` resolves to `not-started`, which is what
 * `closedWithoutCommit` reads as "filed as finished with nothing behind it". The
 * alternative -- skipping the card because it has no block -- would mean the
 * loudest row in the ledger is the one it never emits.
 */
function rowFor(card: PromiseCard, resolve: CommitResolver): PromiseRow | null {
  const { meta } = parseFrontmatter(card.text)
  const status = asStatus(meta.status)
  const promise = parsePromiseBlock(card.text)
  // No status key at all: `detectCardDefects` calls this `missing-status`. It
  // cannot be placed on a lane, so it cannot be FILED, and only a promise block
  // earns it a row.
  if (promise === null && !(status !== null && FILED.has(status))) return null

  const block = promise ?? { agreed: null, conversation: null, session: null, asked: null, closes: [] }
  const commits = block.closes.map(resolve)
  return {
    id: card.id,
    status: status ?? 'inbox',
    title: String(meta.title || card.id),
    ...block,
    commits,
    verdict: verdictFor(commits),
  }
}

/**
 * Every promise worth reporting on one project's board, worst first.
 *
 * ORDERED BY HOW BADLY IT READS, not by time. A ledger sorted newest-first buries
 * the card that was filed as finished eight months ago with nothing behind it
 * under today's routine traffic, and that card is the entire reason to look.
 * `delivered` sinks to the bottom, where it belongs: it is the row that needs no
 * reader.
 */
const VERDICT_ORDER: Record<PromiseRow['verdict'], number> = {
  'commit-missing': 0,
  'not-on-main': 1,
  unverifiable: 2,
  'not-started': 3,
  delivered: 4,
}

export function promiseLedgerRows(
  project: string,
  cards: readonly PromiseCard[],
  resolve: CommitResolver,
  meta: { resolverBase: string | null; scannedAt: number },
): PromiseLedger {
  const rows: PromiseRow[] = []
  for (const card of cards) {
    const row = rowFor(card, resolve)
    if (row !== null) rows.push(row)
  }
  // A filed card with a broken promise outranks an unfiled one with the same
  // verdict -- `done` is the assertion the ledger is arguing with.
  rows.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      Number(FILED.has(b.status)) - Number(FILED.has(a.status)) ||
      a.id.localeCompare(b.id),
  )
  return { project, rows, scanned: cards.length, resolverBase: meta.resolverBase, scannedAt: meta.scannedAt }
}

/**
 * The LOUD set: cards filed as finished with nothing standing behind them.
 *
 * A thin re-export of the core module's `closedWithoutCommit`, and thin on
 * purpose -- both surfaces need the same answer and neither should re-derive
 * "filed" from a lane name of its own. Kept here rather than duplicated in the
 * web because the fold and the table have to agree about what `done` means.
 */
export function brokenPromises(ledger: PromiseLedger): PromiseRow[] {
  return closedWithoutCommit(ledger.rows)
}

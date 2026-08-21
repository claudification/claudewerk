/**
 * THE LIFECYCLE KEYS -- `archived_reason`, `archived_by`, `delete_at`.
 *
 * These three are the whole record of what happened to a card once it leaves
 * the board (epic-morning-report D5/D7): the report markdown and the audit DB
 * are both purgeable, so the card's own frontmatter is the tier that has to
 * survive. A record that is wrong is worse than no record, because it is
 * trusted -- which is why every one of these checks exists BEFORE anything
 * starts writing the keys, rather than after malformed ones accumulate.
 *
 * WHAT THIS FILE OWNS AND WHAT IT DOES NOT. The registry (card-schema-keys.ts)
 * already declares all three, so "is it a scalar" and "does `delete_at` read as
 * a date at all" are answered by project-doctor-schema.ts and are deliberately
 * NOT repeated here -- two passes reporting one root cause is how a report
 * becomes a wall. What is left is everything a key table cannot express:
 * agreement BETWEEN keys (a reason without an archived lane), a POINTER that
 * has to resolve (`duplicate-of:<id>`), and ORDER between two dates.
 *
 * Pure. The board arrives through `LifecycleBoard`, so the whole thing runs
 * identically on the PostToolUse write hook -- where it is handed one card and
 * a reader for the rest -- and on the board-wide `board:doctor` pass.
 */

import type { DoctorFinding } from './project-doctor-types'

/** The one reason value that is a POINTER rather than a literal. */
const DUPLICATE_PREFIX = 'duplicate-of:'

/**
 * ISO 8601 as this board actually writes it: a date, optionally a time, and
 * optionally a zone. Date-only is accepted on purpose -- about ten cards carry a
 * date-only `created:` and a marker a human typed as `2026-09-30` is not wrong.
 * `T` is required as the separator, because a space is the one spelling that
 * `Date.parse` takes and ISO 8601 does not.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export interface LifecycleSource {
  id: string
  /** Raw frontmatter exactly as parsed. NOT a projected card: projection has
   *  already defaulted a missing lane to `inbox`, and "is this card actually
   *  archived" is one of the questions being asked. */
  meta: Record<string, unknown>
}

export interface LifecycleBoard {
  /** Does this board have that card? The SAME id set `checkLinks` is given --
   *  a second resolver would be a second answer to one question. */
  has: (id: string) => boolean
  /** The `duplicate-of` target another card declares, for walking the chain.
   *  Null for a card that is not a duplicate, unreadable, or absent. */
  duplicateTarget: (id: string) => string | null
  /**
   * Wall clock, present ONLY on the write path.
   *
   * "In the future" is a property of the moment the value was WRITTEN, and the
   * write hook is the only place that moment is known. Checking it board-wide
   * would file a warning against every marker that has since elapsed -- which is
   * the normal, expected state of a `delete_at`, because F18 says removal is a
   * human act and the human may take weeks. That permanent warning is exactly
   * the noise that gets a report ignored wholesale, and the elapsed marker is
   * already the scavenger sweep's `note-delete-at` proposal.
   */
  writtenAt?: number
}

/** The card id a reason points at: '' when the prefix carries no id, null when
 *  the reason is not a `duplicate-of` at all. */
export function duplicateTargetOf(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const text = reason.trim()
  if (!text.startsWith(DUPLICATE_PREFIX)) return null
  return text.slice(DUPLICATE_PREFIX.length).trim()
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finding(
  check: string,
  severity: DoctorFinding['severity'],
  id: string,
  problem: string,
  remedy: string,
): DoctorFinding {
  return { check, severity, subject: id, problem, remedy }
}

/**
 * A reason on a live card. Either a leftover from an un-archive or somebody
 * expecting the key to DO the archiving; both leave a card that reads as
 * archived to a grep and sits in a working lane on the board.
 */
function reasonWithoutArchive(source: LifecycleSource, reason: string): DoctorFinding[] {
  const status = str(source.meta.status) || 'inbox'
  if (status === 'archived') return []
  return [
    finding(
      'lifecycle-reason-not-archived',
      'warning',
      source.id,
      `\`archived_reason: ${reason}\` on a card whose lane is \`${status}\` -- the card is not archived, so the reason describes nothing`,
      'set `status: archived`, or drop `archived_reason:` if the card came back to life',
    ),
  ]
}

/** An archived card with a reason and nobody's name on it -- an unattributed
 *  mutation, which defeats the point of keeping the record on the card. */
function reasonWithoutActor(source: LifecycleSource): DoctorFinding[] {
  if (str(source.meta.archived_by)) return []
  return [
    finding(
      'lifecycle-archived-by-missing',
      'warning',
      source.id,
      '`archived_reason:` is set but `archived_by:` is not -- nothing records who archived this card',
      'add `archived_by: <actor>`, e.g. the report that did it (`archived_by: report-2026-08-22`)',
    ),
  ]
}

/**
 * Walk the `duplicate-of` chain from this card's target until it reaches a card
 * that is not itself a duplicate, or comes back to somewhere it has been.
 *
 * TERMINATION IS THE SEEN SET, not a depth cap: every step either stops or adds
 * an id nobody has visited, and the ids come from a board with finitely many
 * cards. A cap would have to choose between missing a long cycle and calling a
 * long honest chain a loop, and neither is a thing to tell somebody.
 */
function duplicateChain(sourceId: string, first: string, board: LifecycleBoard): { chain: string[]; loops: boolean } {
  const chain = [first]
  const seen = new Set([sourceId, first])
  let current = first
  for (;;) {
    const next = board.duplicateTarget(current)
    if (!next) return { chain, loops: false }
    chain.push(next)
    if (seen.has(next)) return { chain, loops: true }
    seen.add(next)
    current = next
  }
}

/**
 * `duplicate-of:<id>` -- the only card key besides linkage that carries a
 * pointer, and the only one whose whole value is "go read that card instead".
 * Every way that sentence can fail to lead anywhere is reported here.
 */
function duplicateFindings(source: LifecycleSource, target: string, board: LifecycleBoard): DoctorFinding[] {
  if (target === '') {
    return [
      finding(
        'lifecycle-duplicate-missing',
        'warning',
        source.id,
        '`archived_reason: duplicate-of:` names no card -- the survivor is unfindable',
        'write `archived_reason: duplicate-of:<card-id>`, or use `done` / `cold`',
      ),
    ]
  }
  if (target === source.id) {
    return [
      finding(
        'lifecycle-duplicate-self',
        'error',
        source.id,
        'this card is archived as a duplicate of ITSELF, so the board claims the surviving card is one that is archived',
        'point `duplicate-of:` at the card that survived, or archive this one as `done` / `cold`',
      ),
    ]
  }
  if (!board.has(target)) {
    return [
      finding(
        'lifecycle-duplicate-missing',
        'warning',
        source.id,
        `archived as \`duplicate-of:${target}\`, which this board does not have`,
        'fix the id, point it at the card that survived, or archive as `done` / `cold`',
      ),
    ]
  }
  const { chain, loops } = duplicateChain(source.id, target, board)
  if (!loops) return []
  return [
    finding(
      'lifecycle-duplicate-cycle',
      'error',
      source.id,
      `the \`duplicate-of\` chain loops (${[source.id, ...chain].join(' -> ')}) -- no card in it is findable as the survivor`,
      'break the loop: exactly one card in a duplicate set stays live and carries no `archived_reason: duplicate-of:`',
    ),
  ]
}

/**
 * `delete_at` -- a MARKER a human acts on, never an instruction (F18). Nothing
 * deletes on it, so nothing here is an error; a wrong one costs the marker, not
 * the card.
 *
 * A value the registry already called unreadable is skipped outright: it has its
 * `card-key-type` finding, with the remedy that says to write an ISO timestamp,
 * and a second line about the same string teaches nobody anything.
 */
function deleteAtFindings(source: LifecycleSource, raw: string, board: LifecycleBoard): DoctorFinding[] {
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return []

  if (!ISO_8601.test(raw)) {
    return [
      finding(
        'lifecycle-delete-at-invalid',
        'warning',
        source.id,
        `\`delete_at: ${raw}\` is a date this board cannot compare -- the sweep reads ISO 8601 and nothing else`,
        'write `delete_at: 2026-09-30` or `delete_at: 2026-09-30T00:00:00Z`',
      ),
    ]
  }

  // `archived_at` is not a key this board declares, but frontmatter is open and
  // an archived card may well carry one -- prefer it when it is there, because
  // "cannot expire before it was archived" is the tighter statement.
  const startKey = Number.isNaN(Date.parse(str(source.meta.archived_at))) ? 'created' : 'archived_at'
  const start = Date.parse(str(source.meta[startKey]))
  if (!Number.isNaN(start) && at < start) {
    // AND NOTHING ELSE. A `delete_at` before `created` is necessarily also in
    // the past, so letting the elapsed check fire too would file one mistake
    // twice, under the vaguer of the two headlines.
    return [
      finding(
        'lifecycle-delete-at-before-start',
        'warning',
        source.id,
        `\`delete_at: ${raw}\` is before this card's \`${startKey}: ${str(source.meta[startKey])}\` -- a card cannot expire before it exists`,
        `set \`delete_at:\` after \`${startKey}:\`, or drop the marker`,
      ),
    ]
  }
  if (board.writtenAt !== undefined && at <= board.writtenAt) {
    return [
      finding(
        'lifecycle-delete-at-past',
        'warning',
        source.id,
        `\`delete_at: ${raw}\` has already elapsed -- an expiry written in the past marks the card for removal the moment it is written`,
        'write a future date, or drop `delete_at:` if the card should be dealt with now',
      ),
    ]
  }
  return []
}

/** Every lifecycle-key problem on one card. */
export function checkLifecycleKeys(source: LifecycleSource, board: LifecycleBoard): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  const reason = str(source.meta.archived_reason)
  if (reason) {
    findings.push(...reasonWithoutArchive(source, reason))
    findings.push(...reasonWithoutActor(source))
    const target = duplicateTargetOf(reason)
    if (target !== null) findings.push(...duplicateFindings(source, target, board))
  }
  const deleteAt = str(source.meta.delete_at)
  if (deleteAt) findings.push(...deleteAtFindings(source, deleteAt, board))
  return findings
}

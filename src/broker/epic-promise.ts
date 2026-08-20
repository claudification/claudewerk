/**
 * THE ENGINE WRITES `closes:` -- the one moment a machine knows which commit
 * delivered a card, and no seat has to remember anything.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A PROMISE IS CLOSED BY A COMMIT ON main. NOTHING ELSE CLOSES IT.         ┃
 * ┃  Not a card moved to `done`. Not a seat saying it finished.               ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * `src/shared/promise-ledger.ts` is the parser, the writer and the verdict.
 * This file is the ENGINE HALF: which card, which branch, which sha, and the
 * refusal when there is no honest answer.
 *
 * WHY THE EXECUTOR AND NOT A SEAT. The card that specified this is emphatic and
 * it is the whole design: the seat that did the work is exactly the seat that
 * must not be the one claiming it landed. The engine is the only party with no
 * stake in the answer. So the write is broker-side, machine-authored, and driven
 * off standing state rather than off anybody's report.
 *
 * WHERE IT SITS IN A BEAT. Beside the acknowledgement pass and BEFORE the
 * actions, which is `b766b75e`'s rule restated: a beat that crashes mid-dispatch
 * must still have recorded what it learned.
 *
 * WHY NOT AT ACKNOWLEDGEMENT EXACTLY -- the one deviation from the card, stated
 * out loud. Acknowledgement fires the beat a card SETTLES, and a card settles
 * when its implementer ends, at which point the card sits in `in-review` and a
 * verifier is about to move it to `done`. Every board status write in this repo
 * goes through `serializeCard`, which flattens a nested `promise:` block and
 * EMPTIES `closes:` (filed as `werk-promise-ledger-card-writer-flattens`, pinned
 * by a test in promise-ledger.test.ts). Writing at acknowledgement would
 * therefore write into a shredder, every time. So the gate is the same standing
 * question asked one lane later: SETTLED AND TERMINAL. Everything the card asked
 * for holds -- engine-side, once per card, card id known, branch already landed.
 *
 * IT NEVER BLOCKS. A promise is bookkeeping, and a blocking chore produces
 * `--skip-check`. Every failure here is log-and-continue: a board that cannot be
 * written loses you a card, never a merge and never a beat.
 */

import { cardRelPath } from '../shared/card-path'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import { appendCloses, type ClosingCommit, insertPromiseBlock } from '../shared/promise-ledger'
import type { TaskStatus } from '../shared/task-statuses'
import type { BranchResolution } from './commit-ledger/branch'
import { epicIo, tag } from './epic-io'
import { cardBranch } from './epic-spawn-plan'
import type { EpicGroup } from './epic-sweep'
import type { BeatDeps } from './epic-types'

/**
 * Lanes where nothing is going to rewrite the card's front matter again.
 *
 * `in-review` is deliberately NOT here even though a settled card usually sits
 * in it: the verifier's `project_set_status` is still to come, and that write is
 * what empties `closes:`.
 */
const TERMINAL_LANES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'archived'])

/** Generous. A truncated read that got written back would DELETE the tail of
 *  somebody's card, so the read is refused rather than trimmed if it trips. */
const MAX_CARD_BYTES = 512 * 1024

/** What one card's pass did. Returned rather than only logged so a test can
 *  assert the decision without parsing a baton entry. */
export interface PromiseRecordOutcome {
  cardId: string
  /** The branch the ledger was asked about. */
  branch: string
  /** Shas actually added to `closes:`. Empty when nothing was written. */
  added: string[]
  /** How the commits were found, or null when none were. */
  via: BranchResolution | null
  /** Why nothing was written. `null` on success AND on an idempotent no-op. */
  refused: string | null
  /**
   * Could a later beat get a different answer?
   *
   * THE DIFFERENCE THAT MATTERS: "the sentinel was not there" and "this card has
   * no front matter" are both refusals, and treating them alike loses one of
   * them. A transient failure that got stamped as final would silently cost the
   * card its receipt for the rest of the run, over a round trip that would have
   * worked 45 seconds later.
   */
  retryable: boolean
}

/**
 * Cards this broker process has finished with, so a settled epic does not pay a
 * card read every 45 seconds for the rest of the run.
 *
 * A CACHE OVER AN IDEMPOTENT OPERATION, which is the only safe direction for one
 * to fail in: `appendCloses` matches a short sha against a full one and adds
 * nothing it already has, so a restart that forgets everything re-reads each
 * card once and writes nothing. Losing the memory costs reads; trusting it
 * wrongly could only ever cost a write we did not need.
 */
const settledPromises = new Set<string>()

/** Cards whose RETRYABLE refusal has already been said once. Separate from the
 *  set above precisely because those refusals are retried -- the commit may
 *  simply not have been made yet -- and repeating the same line every 45 seconds
 *  would bury the baton the overseer actually reads. */
const announced = new Set<string>()

const memoKey = (project: string, epicId: string, cardId: string) => `${project}|${epicId}|${cardId}`

/** Test seam. The two sets above are process-global by design (one broker, one
 *  ledger); a suite that ran two beats over the same card would otherwise see
 *  the second one silently skipped. */
export function resetPromiseMemory(): void {
  settledPromises.clear()
  announced.clear()
}

/**
 * The cards a beat should try to record, in board order.
 *
 * Settled AND terminal AND not already done with. `group.settled` is the
 * engine's own standing answer to "every backing conversation has ended", and
 * the lane is the board's answer to "and nobody is going to rewrite this file".
 * Both have to be true.
 */
function candidates(group: EpicGroup, cards: readonly ProjectTaskMeta[]): ProjectTaskMeta[] {
  const settled = new Set(group.settled)
  return cards.filter(
    c =>
      settled.has(c.slug) &&
      TERMINAL_LANES.has(c.status) &&
      !settledPromises.has(memoKey(group.project, group.epicId, c.slug)),
  )
}

/**
 * FULL hashes, never short ones.
 *
 * A promise is a permanent receipt and a short hash is a prefix -- unambiguous
 * the day it is written, not necessarily unambiguous in a year. The reader
 * matches a prefix against a full hash either way (`sameCommit`), so a
 * hand-written 7-character entry is still recognised and never duplicated.
 */
function closing(commits: readonly { hash: string; subject: string }[]): ClosingCommit[] {
  return commits.map(c => ({ sha: c.hash, subject: c.subject }))
}

/** ISO date the card was filed, which is the closest thing the board has to the
 *  date the work was agreed. The beat's clock only stands in when the board
 *  never stamped one -- and it is the beat's clock, injected, not the process's,
 *  so a test's `agreed:` is not whatever day the suite happened to run. */
function agreedDate(card: ProjectTaskMeta, nowMs: number): string {
  const stamped = card.created.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(stamped) ? stamped : new Date(nowMs).toISOString().slice(0, 10)
}

/** One structured baton entry. EVERYTHING IS A STRUCTURED MESSAGE -- the write
 *  and every refusal both land in the log the overseer actually reads, never in
 *  a `console.log` nobody greps. */
async function say(deps: BeatDeps, group: EpicGroup, cardId: string, body: string): Promise<void> {
  const res = await epicIo().appendBaton(deps, group.project, group.epicId, {
    kind: 'record',
    convId: 'broker',
    cardId,
    body,
  })
  if (!res.ok) deps.log(`${tag(group.epicId, 0)} promise record append FAILED for ${cardId}: ${res.error}`)
}

const refusal = (cardId: string, branch: string, reason: string, retryable: boolean): PromiseRecordOutcome => ({
  cardId,
  branch,
  added: [],
  via: null,
  refused: reason,
  retryable,
})

/** Either the card's current bytes, or the refusal that says why there are none.
 *  Split from the write so each half has one job and one way to go wrong. */
type CardRead = { text: string } | { refused: PromiseRecordOutcome }

/** The card as it stands right now, in full. */
async function readCard(deps: BeatDeps, group: EpicGroup, cardId: string, branch: string): Promise<CardRead> {
  const read = await epicIo().readProjectFile(deps, group.project, cardRelPath(cardId), MAX_CARD_BYTES)
  // RETRYABLE: a missing sentinel and a timed-out round trip both land here, and
  // both are gone by the next beat.
  if (!read.ok || read.content === undefined) {
    return { refused: refusal(cardId, branch, `could not read the card: ${read.error ?? 'no content'}`, true) }
  }
  // A TRUNCATED READ WRITTEN BACK DELETES THE TAIL OF THE CARD. There is no
  // partial write worth having here, and the card will not shrink on its own --
  // so this one is final rather than retried.
  if (read.truncated) {
    return { refused: refusal(cardId, branch, `card is larger than ${MAX_CARD_BYTES} bytes; not rewritten`, false) }
  }
  return { text: read.content }
}

/** Scaffold the block if the card lacks one, then add the shas. Pure -- every
 *  byte outside the `promise:` block survives untouched (LINE SURGERY). */
function splice(
  text: string,
  card: ProjectTaskMeta,
  branch: string,
  commits: ClosingCommit[],
  conversation: string,
  agreed: string,
): { text: string; added: string[] } | { refused: PromiseRecordOutcome } {
  const seeded = insertPromiseBlock(text, {
    agreed,
    conversation,
    // NEVER the CC session id: the broker may not read one, and nothing here
    // needs it. `asked` stays empty on purpose -- a plausible-looking auto-filled
    // ask silences the "no ask written down" warning and tells the next agent
    // nothing.
  })
  // A card the writer cannot parse is left ALONE with the reason logged. Usually
  // it is a card a human is mid-edit on, and clobbering that is the failure the
  // whole line-surgery design exists to avoid -- final, not retried.
  if (seeded.refused) {
    return { refused: refusal(card.slug, branch, `could not scaffold a promise block: ${seeded.refused}`, false) }
  }
  const appended = appendCloses(seeded.text, commits)
  if (appended.refused) {
    return { refused: refusal(card.slug, branch, `could not write closes: ${appended.refused}`, false) }
  }
  return { text: appended.text, added: appended.added }
}

/** Read the card, splice the promise, write it back. */
async function writeCloses(
  deps: BeatDeps,
  group: EpicGroup,
  card: ProjectTaskMeta,
  branch: string,
  via: BranchResolution,
  commits: ClosingCommit[],
  conversation: string,
): Promise<PromiseRecordOutcome> {
  const read = await readCard(deps, group, card.slug, branch)
  if ('refused' in read) return read.refused

  const next = splice(read.text, card, branch, commits, conversation, agreedDate(card, deps.now()))
  if ('refused' in next) return next.refused

  const done = (added: string[]): PromiseRecordOutcome => ({
    cardId: card.slug,
    branch,
    added,
    via,
    refused: null,
    retryable: false,
  })
  // Byte-identical means the card already named every commit we have -- an
  // idempotent no-op, not a refusal, so it is not worth a round trip.
  if (next.text === read.text) return done([])

  const wrote = await epicIo().writeProjectFile(deps, group.project, cardRelPath(card.slug), next.text)
  if (!wrote.ok) {
    return refusal(card.slug, branch, `could not write the card back: ${wrote.error ?? 'unknown'}`, true)
  }
  return done(next.added)
}

/** The sentence the baton gets for one card. Kept beside the outcome type so the
 *  wording and the fields can never describe different events. */
function report(out: PromiseRecordOutcome): string {
  if (out.refused) {
    return (
      `PROMISE NOT RECORDED for \`${out.cardId}\`: ${out.refused}. Its \`closes:\` is unchanged -- nothing was ` +
      'guessed, and "could not verify" is not "it is fine". This is bookkeeping only; no work was blocked.'
    )
  }
  if (out.added.length === 0) {
    return `\`${out.cardId}\` already names every commit the ledger has for \`${out.branch}\`; nothing to add.`
  }
  const how =
    out.via === 'merge'
      ? `the merge commit that brought \`${out.branch}\` onto the trunk`
      : `the commit(s) recorded on \`${out.branch}\` -- NOT yet known to be on main, which the ledger's ` +
        'verdict reports honestly at read time'
  return (
    `\`${out.cardId}\` now closes ${out.added.map(s => `\`${s.slice(0, 12)}\``).join(', ')} -- ${how}. ` +
    'Written by the engine, not by the seat that did the work.'
  )
}

/**
 * Record `closes:` for every settled, terminal card this beat can honestly
 * resolve a sha for.
 *
 * ORDER OF THE TWO LOOKUPS IS THE COST MODEL: the ledger query is a local
 * indexed read and the card is a sentinel round trip, so a card whose branch has
 * no commits yet costs one query and nothing else. That is what makes it safe to
 * ask again on the next beat instead of burning the only chance at the moment
 * the answer happens not to exist yet.
 */
export async function recordSettledPromises(
  deps: BeatDeps,
  group: EpicGroup,
  cards: readonly ProjectTaskMeta[],
): Promise<PromiseRecordOutcome[]> {
  const out: PromiseRecordOutcome[] = []
  for (const card of candidates(group, cards)) out.push(await recordOne(deps, group, card))
  return out
}

/** One card's whole pass: resolve, write, remember, say so. */
async function recordOne(deps: BeatDeps, group: EpicGroup, card: ProjectTaskMeta): Promise<PromiseRecordOutcome> {
  const key = memoKey(group.project, group.epicId, card.slug)
  const branch = cardBranch(group.epicId, card.slug)
  const found = epicIo().commitsForBranch(group.project, branch)

  // NO SHA, NO WRITE. `could not verify` is a real verdict in this design and a
  // guessed hash is not -- a false accusation is worse than a false open,
  // because a ledger nobody trusts is one nobody reads.
  const result = found
    ? await writeCloses(deps, group, card, branch, found.via, closing(found.commits), conversationOf(found.commits))
    : refusal(
        card.slug,
        branch,
        `the commit ledger has no commit on \`${branch}\` and no merge of it onto the trunk`,
        true,
      )

  // Only a FINAL answer retires the card. A retryable refusal is announced once
  // and then asked again silently, so a sentinel that was down for one beat does
  // not cost the card its receipt for the whole run.
  if (result.retryable) {
    if (announced.has(key)) return result
    announced.add(key)
  } else {
    settledPromises.add(key)
    announced.delete(key)
  }

  await say(deps, group, card.slug, report(result))
  if (result.refused) deps.log(`${tag(group.epicId, 0)} promise NOT recorded for ${card.slug}: ${result.refused}`)
  return result
}

/** The conversation a promise is RECOVERABLE through -- whoever committed the
 *  work, straight off the ledger row. An agent that finds the row can pull the
 *  actual transcript instead of re-deriving the requirement from a summary. */
function conversationOf(
  commits: readonly { conversationName: string | null; conversationId: string | null }[],
): string {
  const first = commits[0]
  // TRUTHINESS, not `??`: the post-commit hook interpolates
  // `${CLAUDWERK_CONVERSATION_NAME:-}`, and an unset variable lands as an EMPTY
  // STRING rather than null -- so `??` would record a name of `""` and never
  // reach the conversation id that was actually there.
  return first?.conversationName || first?.conversationId || ''
}

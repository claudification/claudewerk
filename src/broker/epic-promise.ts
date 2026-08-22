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
 * TWO MOMENTS, NOT ONE, and the second one exists because the first can run out
 * of beats:
 *
 *   1. ACKNOWLEDGEMENT -- the moment the card specified. A card settles the beat
 *      its werk-worker ends; that is engine-side, once per card, card id known,
 *      branch already committed. LANE-AGNOSTIC: a settled card in `in-review`
 *      gets its `closes:` immediately, without waiting for a verdict.
 *   2. LAST CALL -- the beat that parks or completes the run. After it, every
 *      later beat returns at `isInertRun` before the card is ever looked at
 *      again, so this is the final chance. See `recordFinalPromises`.
 *
 * AN EARLIER VERSION OF THIS FILE GATED ON `settled AND terminal` and said so in
 * a long comment. That gate is gone. Its stated reason was that `serializeCard`
 * flattened a nested `promise:` block and emptied `closes:`, so writing at
 * acknowledgement wrote into a shredder -- true when it was written, FIXED on
 * main since, by `2ba978d0` and pinned by "THIS repo's own card writer no longer
 * flattens a promise block" in promise-ledger.test.ts. The gate outlived its
 * reason and cost the last card of an epic its receipt permanently.
 *
 * IT NEVER BLOCKS. A promise is bookkeeping, and a blocking chore produces
 * `--skip-check`. Every failure here is log-and-continue: a board that cannot be
 * written loses you a card, never a merge and never a beat. That now includes a
 * card with MIXED LINE ENDINGS, which both writers refuse rather than mangle
 * (`werk-promise-ledger-crlf-write-mangles`) -- a refusal with a reason in the
 * baton, never a silent no-op.
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
 * Lanes that mean the board considers the work finished.
 *
 * NOT a gate on the normal pass -- `group.settled` is, and it is lane-agnostic.
 * This is the LAST CALL's evidence instead: on the beat that parks or completes
 * a run there is no later beat to ask again, so a card that never settled is
 * recorded on the strength of its lane alone. Anything short of terminal is
 * still being worked and gets nothing, which is the point of asking.
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
 *  would bury the baton the werk-master actually reads. */
const announced = new Set<string>()

const memoKey = (project: string, epicId: string, cardId: string) => `${project}|${epicId}|${cardId}`

/** Test seam. The two sets above are process-global by design (one broker, one
 *  ledger); a suite that ran two beats over the same card would otherwise see
 *  the second one silently skipped. */
export function resetPromiseMemory(): void {
  settledPromises.clear()
  announced.clear()
}

/** Has this broker process already reached a FINAL answer for this card? */
const done = (group: EpicGroup, slug: string) => settledPromises.has(memoKey(group.project, group.epicId, slug))

/**
 * The cards a beat should try to record, in board order.
 *
 * SETTLED, and nothing else. `group.settled` is the engine's own standing answer
 * to "every backing conversation for this card has ended" -- which is exactly
 * the acknowledgement moment the card specified, and the moment the branch is
 * known to have been committed. The card's LANE is deliberately not asked about:
 * a settled card sitting in `in-review` has already done the work that produced
 * the sha, and waiting for a verdict to record it only invents ways to miss.
 */
function candidates(group: EpicGroup, cards: readonly ProjectTaskMeta[]): ProjectTaskMeta[] {
  const settled = new Set(group.settled)
  return cards.filter(c => settled.has(c.slug) && !done(group, c.slug))
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
 *  and every refusal both land in the log the werk-master actually reads, never in
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
function report(out: PromiseRecordOutcome, lastCall: boolean): string {
  if (out.refused) {
    // At last call a "retryable" refusal is retryable by nobody -- the run goes
    // inert on this same beat. Saying "we will ask again" there would be a lie
    // the werk-master never gets to catch.
    const again =
      lastCall && out.retryable
        ? ' The run ends on this beat, so there is no later beat to ask again: this is FINAL.'
        : ''
    return (
      `PROMISE NOT RECORDED for \`${out.cardId}\`: ${out.refused}. Its \`closes:\` is unchanged -- nothing was ` +
      `guessed, and "could not verify" is not "it is fine". This is bookkeeping only; no work was blocked.${again}`
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
 * Record `closes:` for every settled card this beat can honestly resolve a sha
 * for.
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

/**
 * LAST CALL -- the beat is about to park or complete the run, so this is the
 * final time any card under it will be looked at.
 *
 * WHY THIS EXISTS AT ALL, and it is not a duplicate of the pass above. A run
 * completes off CARD LANES alone (`planEpic` -> `rollup.complete`); it does not
 * wait for the conversations behind those cards to end. So on the beat where the
 * last child first reads `done` while its werk-verifier is still alive, that card is
 * NOT in `group.settled`, the normal pass skips it -- and `settleRun` then flips
 * the run to `complete`, after which every later beat returns at `isInertRun`
 * before the card is reached. There is no next beat. Without this, the one card
 * per epic most likely to hit that race loses its receipt permanently.
 *
 * The gate here is the LANE, because at last call there is no settle signal left
 * to lean on and the board saying `done`/`archived` is the only evidence there
 * is. A parked run with children still in flight records nothing for them, which
 * is correct: they are not finished, and a promise is a claim about finished
 * work.
 *
 * The memo makes this cheap and safe to layer on top: a card already recorded
 * this run is skipped, and `appendCloses` would add nothing anyway.
 */
export async function recordFinalPromises(
  deps: BeatDeps,
  group: EpicGroup,
  children: readonly ProjectTaskMeta[],
): Promise<PromiseRecordOutcome[]> {
  const out: PromiseRecordOutcome[] = []
  for (const card of children) {
    if (!TERMINAL_LANES.has(card.status) || done(group, card.slug)) continue
    out.push(await recordOne(deps, group, card, true))
  }
  return out
}

/** One card's whole pass: resolve, write, remember, say so. */
async function recordOne(
  deps: BeatDeps,
  group: EpicGroup,
  card: ProjectTaskMeta,
  lastCall = false,
): Promise<PromiseRecordOutcome> {
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
  // not cost the card its receipt for the whole run. AT LAST CALL nothing is
  // retryable in practice -- the run goes inert on this beat -- so the refusal is
  // said even if an earlier beat already said its softer version.
  if (result.retryable && !lastCall) {
    if (announced.has(key)) return result
    announced.add(key)
  } else {
    if (retires(card, lastCall)) settledPromises.add(key)
    announced.delete(key)
  }

  // AN IDEMPOTENT NO-OP IS A NON-EVENT. Dropping the lane gate means a card can
  // legitimately be asked again beat after beat (see `retires`), and a baton
  // line every 45 seconds saying "nothing to add" would bury the entries the
  // werk-master actually reads.
  if (result.added.length > 0 || result.refused) await say(deps, group, card.slug, report(result, lastCall))
  if (result.refused) deps.log(`${tag(group.epicId, 0)} promise NOT recorded for ${card.slug}: ${result.refused}`)
  return result
}

/**
 * Is this card DONE WITH for the rest of the run, or can it still gain commits?
 *
 * THE BOUNCE IS WHY THIS IS NOT JUST "we got an answer". A werk-verifier can send a
 * card back to `open`, a second werk-worker picks it up and commits more, and
 * that card settles a second time. Retiring it on the first settle would freeze
 * its `closes:` at round one's shas and quietly under-report what delivered it.
 * So a card is only retired once its LANE says nobody is going back to it -- or
 * at last call, when there is no next beat to ask on anyway.
 *
 * Re-asking is cheap and safe by construction: the ledger query is a local
 * indexed read, `appendCloses` adds only what is missing, and a pass that adds
 * nothing now says nothing.
 */
function retires(card: ProjectTaskMeta, lastCall: boolean): boolean {
  return lastCall || TERMINAL_LANES.has(card.status)
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

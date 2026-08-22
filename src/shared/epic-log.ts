/**
 * THE EPIC BATON -- log.md, append-only, never rewritten.
 *
 * This is the werk-master's memory. Every generation is a FRESH conversation with no
 * transcript from the last one, so what the run knows about itself is exactly
 * what is in this file. That is the point: an epic that takes three days and
 * forty generations cannot live in a context window, and a summary written by
 * the agent that did the work is the one thing we already decided not to trust.
 *
 * There is deliberately no patch/rewrite path (same reasoning as quest-log.ts).
 * A generation that wants to correct an earlier entry APPENDS a correction; the
 * wrong entry stays, because "what did it believe at the time" is the question
 * you actually need answered when a run goes sideways.
 */

import { mkdirSync } from 'node:fs'
import { composeBatonTag, parseBatonTag } from './epic-log-tag'
import { epicDir, epicLogFile, nowIso } from './epic-paths'
import type { EpicLogEntry, EpicLogKind } from './epic-run-types'
import { appendSectionLog, readSectionLog, renderLogSection } from './md-section-log'

const LOG_HEADER =
  '# Epic Baton\n\nAppend-only. Every werk-master generation reads this and nothing else about the past.\n\n'

const KINDS: readonly EpicLogKind[] = [
  'intent',
  'dispatch',
  'dispatch-failed',
  'completion',
  'verdict',
  'blocked',
  'merge',
  'steering',
  'checkpoint',
  'werk-master-lost',
  'record',
  'friction',
]

/**
 * The kind, or `intent` for a word this build does not know.
 *
 * `werk-master-lost` WAS `overseer-lost` UNTIL THE SEAT RENAME, and baton lines
 * written before it keep the old word: a baton is append-only and never
 * rewritten, which is the whole premise of this file. So one class of historical
 * line -- a supervisor the engine reaped -- now reads back as `intent`.
 *
 * That is the accepted cost, stated rather than papered over, and it is small
 * for two reasons. The kind is read by the RENDERER and by `ACKNOWLEDGING_KINDS`
 * (which never contained it), so no decision moves. And `epic-beat-actions.ts`
 * dedupes its reap entry on the kind, so an epic live across the rename may
 * append one duplicate for a supervisor already recorded under the old word --
 * once, per already-reaped supervisor.
 *
 * The alternative was tolerating the old spelling here forever, which is exactly
 * the permanent alias the rename decided against. See `migrate.ts` v8.
 */
function asEpicLogKind(v: unknown): EpicLogKind {
  return KINDS.includes(v as EpicLogKind) ? (v as EpicLogKind) : 'intent'
}

/**
 * The baton's `tag` slot carries BOTH ids, composed -- that is the whole
 * difference between this log's header and a quest's.
 *
 * The composition lives in `epic-log-tag.ts` and nowhere else: this function and
 * `readEpicLog` are the only two places in the system that see a tag, so the
 * split is a parse boundary rather than a format everybody has to know.
 */
function toSection(e: EpicLogEntry) {
  const tag = composeBatonTag(e.epicId, e.cardId)
  return { ts: e.ts, kind: e.kind, convId: e.convId, ...(tag ? { tag } : {}), body: e.body }
}

export interface AppendEpicLogInput {
  kind: EpicLogKind
  convId: string
  body: string
  /** The epic this entry is ABOUT, when that is not the log being written to.
   *  Omitted means the log's own epic, which is every caller today. */
  epicId?: string
  cardId?: string
  ts?: string
}

/**
 * The MACHINE acknowledgement of a settle, written by the broker's `acknowledge`.
 *
 * Recognised here, not just written there, because this is the one entry the log
 * must hold at most once per card: a second copy says nothing new and costs a
 * slot in the tail every prompt is sized around. Agent-authored entries about
 * the same card (a verdict, a correction) are a different thing and stay
 * append-only, per this file's whole premise.
 */
function isMachineAcknowledgement(entry: EpicLogEntry): boolean {
  return entry.kind === 'completion' && entry.convId === 'broker' && Boolean(entry.cardId)
}

/** The identity the at-most-once rule is keyed on: a card WITHIN an epic. Card
 *  ids are unique on a board, but a baton shared by several epics must not let
 *  one epic's acknowledgement suppress another's. */
function sameSettle(a: EpicLogEntry, b: EpicLogEntry): boolean {
  return a.cardId === b.cardId && a.epicId === b.epicId
}

/**
 * Append ONE entry, creating the file (and its dir) with a header if needed.
 *
 * IDEMPOTENT for machine acknowledgements only: re-acknowledging a card returns
 * the entry already on disk and writes nothing. Live 2026-08-19 this log held
 * NINE identical `completion [broker] wall-surface-shell` lines, appended every
 * ~45s by a beat that could not see its own earlier acknowledgement. The read
 * bug that caused it is fixed (`acknowledgedCardIds`); this is the belt, so a
 * future reader of `log.md` never has to work out which of nine is real.
 */
export function appendEpicLog(root: string, epicId: string, input: AppendEpicLogInput, nowMs: number): EpicLogEntry {
  mkdirSync(epicDir(root, epicId), { recursive: true })
  const entry: EpicLogEntry = {
    ts: input.ts ?? nowIso(nowMs),
    kind: asEpicLogKind(input.kind),
    convId: input.convId || 'unknown',
    epicId: input.epicId || epicId,
    ...(input.cardId ? { cardId: input.cardId } : {}),
    body: input.body,
  }
  if (isMachineAcknowledgement(entry)) {
    const existing = readEpicLog(root, epicId).find(e => isMachineAcknowledgement(e) && sameSettle(e, entry))
    if (existing) return existing
  }
  appendSectionLog(epicLogFile(root, epicId), LOG_HEADER, toSection(entry))
  return entry
}

/**
 * Every entry in append order. Tolerates a missing or half-written file.
 *
 * THE PARSE BOUNDARY. `epicId` is the argument that located the file, and it is
 * what a tag that names no epic falls back to -- which is every tag written
 * before this split existed. That is why backward compatibility here is a total
 * function and not a heuristic: the reader already knows the answer.
 */
export function readEpicLog(root: string, epicId: string): EpicLogEntry[] {
  return readSectionLog(epicLogFile(root, epicId)).map(s => {
    const tag = parseBatonTag(s.tag, epicId)
    return {
      ts: s.ts,
      kind: asEpicLogKind(s.kind),
      convId: s.convId,
      epicId: tag.epicId,
      ...(tag.cardId ? { cardId: tag.cardId } : {}),
      body: s.body,
    }
  })
}

/**
 * The last `n` entries, newest last. What a fresh werk-master generation is handed.
 *
 * Tail rather than whole-file because the baton grows without bound and the
 * prompt does not: a forty-generation epic's early entries are already reflected
 * in the board state the werk-master reads alongside this.
 */
export function readEpicLogTail(root: string, epicId: string, n = 20): EpicLogEntry[] {
  const all = readEpicLog(root, epicId)
  return n >= all.length ? all : all.slice(all.length - n)
}

/**
 * Entries for one card, oldest first -- "what has already happened to t7".
 *
 * Matched on the epic AS WELL AS the card. A no-op while a baton is per-epic,
 * and the difference between an answer and a lie once one is not: the same card
 * id can appear under a second epic in a shared baton, and "what happened to t7"
 * asked of epic E must not return E2's history of it.
 */
export function readEpicLogForCard(root: string, epicId: string, cardId: string): EpicLogEntry[] {
  return readEpicLog(root, epicId).filter(e => e.cardId === cardId && e.epicId === epicId)
}

/** How much of the baton, and which of it. */
export interface BatonQuery {
  /** Entries to return, newest last. Omitted = the prompt-sized default. */
  limit?: number
  /** Keep only these kinds. Omitted = all of them. */
  kinds?: readonly EpicLogKind[]
  /** Keep only entries about this card. */
  cardId?: string
}

/**
 * The baton, FILTERED then tailed -- the read a human debugging a run wants
 * ("every verdict", "everything about t5"), as opposed to the fixed prompt-sized
 * tail a werk-master generation is handed.
 *
 * Filter-then-tail, never tail-then-filter: asking for the last 10 verdicts must
 * search the whole log, not return however many verdicts happen to fall inside
 * the last 10 entries. The file is read whole either way (`readEpicLog`), so the
 * correct order here is free.
 */
export function sliceEpicLog(entries: readonly EpicLogEntry[], query: BatonQuery = {}): EpicLogEntry[] {
  const kinds = query.kinds?.length ? new Set(query.kinds) : null
  const matched = entries.filter(e => (!kinds || kinds.has(e.kind)) && (!query.cardId || e.cardId === query.cardId))
  const n = query.limit && query.limit > 0 ? query.limit : 20
  return n >= matched.length ? matched : matched.slice(matched.length - n)
}

export function readEpicLogSlice(root: string, epicId: string, query: BatonQuery = {}): EpicLogEntry[] {
  return sliceEpicLog(readEpicLog(root, epicId), query)
}

/**
 * WHICH CARDS THE BATON HAS ACKNOWLEDGED -- computed over the WHOLE log, never
 * over a tail.
 *
 * This is the question the wake is built on, and it is not a tail question. It
 * was being answered by intersecting the settled set with the prompt-sized
 * 20-entry tail, so any card whose acknowledgement had scrolled out of that
 * window read as unacknowledged again -- forever, because each re-acknowledgement
 * pushed another one out. epic-the-wall froze on exactly this for five
 * generations (gens 23-28, 2026-08-19): 62 held beats, 0 dispatches.
 *
 * A `dispatch` entry acknowledges NOTHING: it records that work started, and
 * treating it as an outcome is how a settle would go unnoticed.
 */
const ACKNOWLEDGING_KINDS: ReadonlySet<EpicLogKind> = new Set<EpicLogKind>(['completion', 'verdict'])

export function acknowledgedCardIds(entries: readonly EpicLogEntry[]): string[] {
  const ids = new Set<string>()
  for (const e of entries) if (ACKNOWLEDGING_KINDS.has(e.kind) && e.cardId) ids.add(e.cardId)
  return [...ids]
}

/**
 * HOW MANY SEATS EACH CARD HAS COST, over the WHOLE log -- the ceiling on the
 * redispatch path (`epic-ready.ts`, `MAX_CARD_SEATS`).
 *
 * THE BATON, NOT THE CONVERSATION REGISTRY, and the difference is the whole
 * reason this exists. `spawnForCard` appends a `dispatch` entry the instant a
 * spawn is accepted, whereas a spawned conversation carries no epic tag until
 * its agent host connects (`setPendingLaunchConfig` is consumed by the meta
 * handler) -- so a seat dispatched on beat N is invisible to `EpicGroup.inFlight`
 * on beat N+1 and countable here immediately. A registry-derived count would read
 * zero in exactly the window a runaway starts in.
 *
 * Whole log, never the prompt-sized tail, for `acknowledgedCardIds`'s reason: a
 * ceiling computed over the last 20 entries is a ceiling that resets itself, and
 * this one exists to stop the thirteen-seat night.
 *
 * ROLE-BLIND on purpose. `spawnForCard` writes the same `dispatch` kind for an
 * werk-worker and for a werk-verifier, and nothing in the entry distinguishes them
 * (adding a role would be a schema change to `md-section-log` for a number whose
 * only consumer is a ceiling). So this counts SEATS, which is the unit the
 * ceiling is denominated in -- a healthy card costs two, one of each.
 *
 * `dispatch-failed` is NOT counted: every failed launch already has its own
 * `dispatch` entry ahead of it, and the launch path has its own bound in
 * `MAX_LAUNCH_ATTEMPTS`.
 */
export function dispatchCountsByCard(entries: readonly EpicLogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of entries) {
    if (e.kind !== 'dispatch' || !e.cardId) continue
    counts[e.cardId] = (counts[e.cardId] ?? 0) + 1
  }
  return counts
}

/** Render a tail as the markdown block a prompt embeds. */
export function renderEpicLogTail(entries: readonly EpicLogEntry[]): string {
  if (entries.length === 0) return '_(empty -- this is the first generation)_'
  return entries.map(e => renderLogSection(toSection(e))).join('\n')
}

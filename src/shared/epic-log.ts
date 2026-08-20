/**
 * THE EPIC BATON -- log.md, append-only, never rewritten.
 *
 * This is the overseer's memory. Every generation is a FRESH conversation with no
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
import { epicDir, epicLogFile, nowIso } from './epic-paths'
import type { EpicLogEntry, EpicLogKind } from './epic-run-types'
import { appendSectionLog, readSectionLog, renderLogSection } from './md-section-log'

const LOG_HEADER =
  '# Epic Baton\n\nAppend-only. Every overseer generation reads this and nothing else about the past.\n\n'

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
]

function asEpicLogKind(v: unknown): EpicLogKind {
  return KINDS.includes(v as EpicLogKind) ? (v as EpicLogKind) : 'intent'
}

/** The baton's `tag` slot carries the card id -- that is the whole difference
 *  between this log's header and a quest's. */
function toSection(e: EpicLogEntry) {
  return { ts: e.ts, kind: e.kind, convId: e.convId, ...(e.cardId ? { tag: e.cardId } : {}), body: e.body }
}

export interface AppendEpicLogInput {
  kind: EpicLogKind
  convId: string
  body: string
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
    ...(input.cardId ? { cardId: input.cardId } : {}),
    body: input.body,
  }
  if (isMachineAcknowledgement(entry)) {
    const existing = readEpicLog(root, epicId).find(e => isMachineAcknowledgement(e) && e.cardId === entry.cardId)
    if (existing) return existing
  }
  appendSectionLog(epicLogFile(root, epicId), LOG_HEADER, toSection(entry))
  return entry
}

/** Every entry in append order. Tolerates a missing or half-written file. */
export function readEpicLog(root: string, epicId: string): EpicLogEntry[] {
  return readSectionLog(epicLogFile(root, epicId)).map(s => ({
    ts: s.ts,
    kind: asEpicLogKind(s.kind),
    convId: s.convId,
    ...(s.tag ? { cardId: s.tag } : {}),
    body: s.body,
  }))
}

/**
 * The last `n` entries, newest last. What a fresh overseer generation is handed.
 *
 * Tail rather than whole-file because the baton grows without bound and the
 * prompt does not: a forty-generation epic's early entries are already reflected
 * in the board state the overseer reads alongside this.
 */
export function readEpicLogTail(root: string, epicId: string, n = 20): EpicLogEntry[] {
  const all = readEpicLog(root, epicId)
  return n >= all.length ? all : all.slice(all.length - n)
}

/** Entries for one card, oldest first -- "what has already happened to t7". */
export function readEpicLogForCard(root: string, epicId: string, cardId: string): EpicLogEntry[] {
  return readEpicLog(root, epicId).filter(e => e.cardId === cardId)
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
 * tail an overseer generation is handed.
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

/** Render a tail as the markdown block a prompt embeds. */
export function renderEpicLogTail(entries: readonly EpicLogEntry[]): string {
  if (entries.length === 0) return '_(empty -- this is the first generation)_'
  return entries.map(e => renderLogSection(toSection(e))).join('\n')
}

/**
 * Transcript entry-forwarding policy.
 *
 * THE one place that decides which JSONL entries a transport forwards to the
 * broker. Every reader of the transcript file -- the live watcher and the
 * resend/recovery path alike -- routes its batches through here, so the policy
 * lives in exactly one table instead of as `if (ctx.headless)` sprinkled at
 * each call site.
 *
 * ## Why a policy is needed at all
 *
 * The JSONL file and the stream-json stdout pipe are NOT the same record --
 * neither is a superset of the other. Measured against CC 2.1.215 on a single
 * session (`be2113d5`):
 *
 *   JSONL only : queue-operation, attachment, last-prompt,
 *                system/stop_hook_summary, system/api_error
 *   stdout only: system (every OTHER subtype), stream_event, result,
 *                rate_limit_event, tool_progress
 *   both       : user, assistant
 *
 * `system` splits by SUBTYPE, and getting that wrong cost us: this table used to
 * read "stdout only: system", so `stop_hook_summary` was never forwarded live.
 * The production store settles it -- in one day, `stop_hook_summary` was 82 rows
 * from the FILE and 0 from stdout, `api_error` 1 and 0, while `status` (4123),
 * `away_summary` (112), `notification` (88) and `background_tasks_changed` (31)
 * were 100% stdout and never appear in the JSONL at all.
 *
 * PTY and daemon have no stdout stream, so they forward the file verbatim.
 * Headless already receives user/assistant live over stdout, so re-forwarding
 * them from the file would duplicate the whole transcript. It must forward only
 * what stdout cannot deliver.
 *
 * ## The table
 *
 * |                | incremental (tail)     | isInitial (boot/compaction/resend)       |
 * |----------------|------------------------|------------------------------------------|
 * | PTY / daemon   | everything             | everything                               |
 * | headless       | HEADLESS_LIVE_TYPES    | everything EXCEPT LIVE and NEVER types,  |
 * |                | + LIVE_SYSTEM_SUBTYPES | but INCLUDING LIVE_SYSTEM_SUBTYPES       |
 *
 * The headless cells are complements with two exceptions: HEADLESS_NEVER_TYPES
 * are forwarded in neither (JSONL-only, no renderer -- see below), and
 * HEADLESS_LIVE_SYSTEM_SUBTYPES in both (JSONL-only, so no stdout copy exists
 * to duplicate against). Otherwise an entry is forwarded live, or in the
 * initial batch, or -- if it renders nowhere -- not at all.
 *
 * The `isInitial` column matters because that batch is the FULL-RECORD path:
 * stripping user/assistant out of it would leave a stdout drop with no recovery
 * route at all. It is NOT a snapshot the broker may swap its cache for -- it is
 * only the file's share of the record, and the broker reconciles it against the
 * store instead (see broker/conversation-store/transcript-cache-write.ts).
 */

import type { TranscriptEntry } from '../shared/protocol'

/**
 * JSONL-only entry types forwarded LIVE in headless.
 *
 * Deliberately narrower than the full JSONL-only set above: `attachment` and
 * `last-prompt` are equally invisible to stdout, but nothing renders them yet,
 * and adding them here would also pull them OUT of the headless initial batch
 * (the cells are complements). Widen this set only together with a renderer.
 *
 * `queue-operation` carries CC's message-queue transitions -- enqueue /
 * dequeue / remove / popAll / popOne. Without it headless can never show that
 * a mid-turn message is queued rather than already being worked on.
 */
const HEADLESS_LIVE_TYPES = new Set(['queue-operation'])

/**
 * `system` subtypes CC writes only to the JSONL, so headless must take them from
 * the file or never see them.
 *
 * These were resend-only until now, and resend-only means late: every one of the
 * 82 `stop_hook_summary` rows in a measured day reached the broker on a
 * reconnect or compaction, 28 minutes late on average and 2.5 hours at worst,
 * keeping its original timestamp while taking a fresh high seq. An `api_error`
 * -- the entry you most want in position -- had the same fate.
 *
 * Unlike the rest of `HEADLESS_LIVE_TYPES` these are ALSO kept in the isInitial
 * batch rather than being its complement. There is no stdout twin to duplicate,
 * the store dedups on CC's own uuid anyway, and the complement would strand the
 * historical ones when a resumed conversation's only source is the file.
 */
const HEADLESS_LIVE_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'api_error'])

/**
 * JSONL-only types that headless forwards in NEITHER cell.
 *
 * `attachment` and `last-prompt` are invisible to stdout AND have no renderer,
 * so they only ever reach the broker via an `isInitial` file resend -- minutes
 * late, under CC's own uuids, at MAX(seq)+1. With the store as seq authority
 * that lands ~100 stale rows at the tail on every resend: they eat the display
 * window (real entries fall off) and shove ordering around. Since nothing shows
 * them, drop them from the initial batch too (pre-`f4f67ad4` behavior). Move a
 * type OUT of here and INTO HEADLESS_LIVE_TYPES the day it gets a renderer.
 */
const HEADLESS_NEVER_TYPES = new Set(['attachment', 'last-prompt'])

/** True for entries headless forwards from the file live rather than via stdout. */
export function isHeadlessLiveEntry(entry: TranscriptEntry): boolean {
  const e = entry as { type?: string }
  if (e.type === 'system') return isHeadlessFileOnlySystemEntry(entry)
  return HEADLESS_LIVE_TYPES.has(e.type ?? '')
}

/** True for the file-only `system` subtypes -- forwarded in BOTH cells. */
function isHeadlessFileOnlySystemEntry(entry: TranscriptEntry): boolean {
  const e = entry as { type?: string; subtype?: string }
  return e.type === 'system' && HEADLESS_LIVE_SYSTEM_SUBTYPES.has(e.subtype ?? '')
}

/** True for JSONL-only entries headless never forwards (no renderer, resend-only). */
function isHeadlessNeverEntry(entry: TranscriptEntry): boolean {
  return HEADLESS_NEVER_TYPES.has((entry as { type?: string }).type ?? '')
}

export interface ForwardSelection {
  /** Whether stdout already carries user/assistant for this transport. */
  headless: boolean
  /** Whether this batch is a full-record batch (boot, compaction reset, resend). */
  isInitial: boolean
}

/**
 * Apply the table above to one batch. Returns the entries the caller should
 * hand to the broker (possibly empty -- callers should skip empty sends).
 */
export function selectForwardableEntries(
  entries: TranscriptEntry[],
  { headless, isInitial }: ForwardSelection,
): TranscriptEntry[] {
  if (!headless) return entries
  return isInitial
    ? entries.filter(e => isHeadlessFileOnlySystemEntry(e) || (!isHeadlessLiveEntry(e) && !isHeadlessNeverEntry(e)))
    : entries.filter(isHeadlessLiveEntry)
}

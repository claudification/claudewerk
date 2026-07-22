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
 *   JSONL only : queue-operation, attachment, last-prompt
 *   stdout only: system, stream_event, result, rate_limit_event, tool_progress
 *   both       : user, assistant
 *
 * PTY and daemon have no stdout stream, so they forward the file verbatim.
 * Headless already receives user/assistant live over stdout, so re-forwarding
 * them from the file would duplicate the whole transcript. It must forward only
 * what stdout cannot deliver.
 *
 * ## The table
 *
 * |                | incremental (tail)     | isInitial (boot/compaction/resend)      |
 * |----------------|------------------------|-----------------------------------------|
 * | PTY / daemon   | everything             | everything                              |
 * | headless       | HEADLESS_LIVE_TYPES    | everything EXCEPT LIVE and NEVER types  |
 *
 * The headless cells are complements save for HEADLESS_NEVER_TYPES, which are
 * forwarded in neither (JSONL-only, no renderer -- see below): an entry is
 * forwarded live, or in the initial batch, or (if it renders nowhere) not at all.
 *
 * The `isInitial` column matters because an `isInitial` batch REPLACES the
 * broker's transcript cache -- it is the full-record path, and stripping
 * user/assistant out of it would blank the conversation.
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
  return HEADLESS_LIVE_TYPES.has((entry as { type?: string }).type ?? '')
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
    ? entries.filter(e => !isHeadlessLiveEntry(e) && !isHeadlessNeverEntry(e))
    : entries.filter(isHeadlessLiveEntry)
}

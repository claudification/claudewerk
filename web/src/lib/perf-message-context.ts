/**
 * Per-message attribution context for the perf monitor.
 *
 * Bridges "which inbound wire message caused this cost" across the two seams
 * where a message's cost actually lands:
 *
 *   1. SYNCHRONOUS apply  -- the handler runs inside flushMessages' batched
 *      loop. Whatever cost the handler spends building new state is fully
 *      synchronous and attributable to exactly one message. `beginMessage()`
 *      / `endMessage()` bracket that window; any record() inside inherits the
 *      tag (see perf-metrics.record()).
 *
 *   2. ASYNCHRONOUS render -- the Zustand notify is deferred to the end of the
 *      batch, so the React commit + commit->paint happen AFTER every per-message
 *      span has closed. There's no single message to blame -- the whole flush
 *      batch triggered one render. `setFlushBatch()` stamps the batch label so
 *      the render / grouping / commit->paint entries that fire in its wake
 *      inherit it.
 *
 * Precedence in currentMessageTag(): a live sync span wins (precise, one
 * message); otherwise the most recent flush batch (the render attribution).
 *
 * This module holds ONLY mutable state + accessors and imports nothing from
 * perf-metrics, so perf-metrics can import currentMessageTag() without a cycle.
 *
 * Scope note: only the buffered dispatch path (handlers[msg.type] via
 * processMessage) is instrumented. The latency-critical bypass handlers
 * (terminal_data, shell_data, json_stream_data, bg_task_output) are raw byte
 * streams, not store-churning wire messages -- timing every PTY chunk would
 * flood the ring and add hot-path overhead for no diagnostic value.
 */

// Live synchronous span: the single message currently being applied.
let syncTag: string | null = null

// Most recent flush batch label (e.g. "transcript_entriesx3,status_update").
// Renders triggered by the batch's store mutation inherit this.
let batchTag: string | null = null

// Monotonic stamp so a stale clear-timer never wipes a newer batch's tag.
let batchStamp = 0

// How long after a flush a render is still attributed to that batch. During
// active streaming, flushes are <16ms apart so the tag is always fresh; this
// window only matters for an otherwise-idle render that the last batch
// genuinely settled. Bounded so idle renders well after the fact stay untagged.
const BATCH_ATTRIBUTION_WINDOW_MS = 250

export function beginMessage(type: string): void {
  syncTag = type
}

export function endMessage(): void {
  syncTag = null
}

export function setFlushBatch(label: string): void {
  batchTag = label
  batchStamp += 1
  const mine = batchStamp
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      // Only clear if no newer batch replaced us in the meantime.
      if (batchStamp === mine) batchTag = null
    }, BATCH_ATTRIBUTION_WINDOW_MS)
  }
}

/** The message (or batch) to credit for a cost recorded right now. */
export function currentMessageTag(): string | undefined {
  return syncTag ?? batchTag ?? undefined
}

/** Test-only reset. */
export function _resetMessageContext(): void {
  syncTag = null
  batchTag = null
  batchStamp = 0
}

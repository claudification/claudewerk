/**
 * rAF message buffer: one React render per frame, not one per message.
 *
 * State-updating messages queue here and drain inside a single
 * unstable_batchedUpdates, so a burst of transcript entries costs one commit.
 * Latency-sensitive traffic never reaches this module -- ws-bypass-routes
 * dispatches it straight off the wire.
 *
 * Module-level on purpose: the buffer belongs to the browser tab, not to a
 * React mount, and every socket in the tab feeds the same frame.
 */

import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { beginMessage, endMessage, setFlushBatch } from '@/lib/perf-message-context'
import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { refetchStaleTranscripts } from './transcript-refetch'
import { useConversationsStore } from './use-conversations'
import { type DashboardMessage, handlers } from './use-websocket-handlers'
import { recordFlushDepth } from './ws-rtt'
import { settleSyncCatchUp } from './ws-sync-protocol'

// Graceful fallback if unstable_batchedUpdates is ever removed
const batch: (fn: () => void) => void = batchUpdates ?? (fn => fn())

let msgBuffer: DashboardMessage[] = []
let rafScheduled = false

/** Queue a state-updating message for the next frame's batched flush. */
export function enqueueMessage(msg: DashboardMessage) {
  msgBuffer.push(msg)
  scheduleFlush()
}

function scheduleFlush() {
  if (!rafScheduled) {
    rafScheduled = true
    requestAnimationFrame(flushMessages)
  }
}

/**
 * Flush buffered messages in a single batched update.
 * All Zustand setState calls inside unstable_batchedUpdates
 * are coalesced into one React render.
 */
function flushMessages() {
  rafScheduled = false
  if (msgBuffer.length === 0) return

  const pending = msgBuffer
  msgBuffer = []

  // The rAF backlog, at the one moment it is knowable: how many messages piled
  // up since the last frame. P4's socket tile reports the high-water mark of
  // this between its probes (see ws-rtt.ts) -- sampling msgBuffer.length from
  // the outside would read 0 forever, because this line has already drained it.
  recordFlushDepth(pending.length)

  trackSyncPosition(pending)

  const flushT0 = isPerfEnabled() ? performance.now() : 0
  // Credit the render this flush triggers to the batch's dominant message type
  // BEFORE batch() runs: unstable_batchedUpdates flushes its coalesced setState
  // synchronously at return, so the React commit (and its Profiler/render
  // records) fires while we're still inside flushMessages -- the tag has to be
  // live by then. The per-message sync span (beginMessage) takes precedence
  // inside the loop, then clears, leaving the batch tag for the commit.
  if (flushT0) setFlushBatch(dominantFlushType(pending))
  batch(() => {
    for (const msg of pending) {
      if (!flushT0) {
        processMessage(msg)
        continue
      }
      const type = (msg as { type?: string }).type ?? 'unknown'
      const t0 = performance.now()
      beginMessage(type)
      try {
        processMessage(msg)
      } finally {
        // Recorded while the span is still open, so the apply entry itself
        // carries msgType=type. This is handler compute only -- the Zustand
        // notify is deferred to batch() return (credited to the batch tag).
        perfRecord('message', `apply:${type}`, performance.now() - t0)
        endMessage()
      }
    }
  })
  if (flushT0) perfRecord('ws', 'flush', performance.now() - flushT0, summarizeFlush(pending))
  settleSyncCatchUp()
}

/** Track sync state (epoch+seq) from incoming messages. */
function trackSyncPosition(pending: DashboardMessage[]) {
  const { syncSeq: prevSeq, syncEpoch: prevEpoch } = useConversationsStore.getState()
  let maxSeq = prevSeq
  let epoch = prevEpoch
  for (const msg of pending) {
    const m = msg as DashboardMessage & { _epoch?: string; _seq?: number }
    if (m._epoch && m._seq) {
      epoch = m._epoch
      if (m._seq > maxSeq) maxSeq = m._seq
    }
  }
  if (maxSeq > prevSeq || epoch !== prevEpoch) {
    useConversationsStore.setState({ syncEpoch: epoch, syncSeq: maxSeq })
  }
}

function flushTypeCounts(pending: DashboardMessage[]): Array<[string, number]> {
  const types: Record<string, number> = {}
  for (const msg of pending) {
    const t = (msg as { type?: string }).type ?? 'unknown'
    types[t] = (types[t] ?? 0) + 1
  }
  return Object.entries(types).sort((a, b) => b[1] - a[1])
}

function summarizeFlush(pending: DashboardMessage[]): string {
  const detail = flushTypeCounts(pending)
    .map(([t, n]) => (n === 1 ? t : `${t}x${n}`))
    .join(',')
  return `n=${pending.length} ${detail}`
}

// The single message type that most drove this flush -- the render attribution
// key. A pure-streaming batch (all transcript_entries) is exact; a mixed batch
// credits its render cost to the heaviest contributor (documented approximation
// in perf-message-context). Full composition stays visible in the 'flush' entry.
function dominantFlushType(pending: DashboardMessage[]): string {
  return flushTypeCounts(pending)[0]?.[0] ?? 'unknown'
}

function processMessage(msg: DashboardMessage) {
  // All sync responses may carry staleTranscripts - handle once before type-specific logic
  const syncMsg = msg as DashboardMessage & { staleTranscripts?: Record<string, number> }
  if (syncMsg.staleTranscripts) refetchStaleTranscripts(syncMsg.staleTranscripts)

  const handler = handlers[msg.type]
  if (handler) handler(msg)
}

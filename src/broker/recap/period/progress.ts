import type { RecapResolution, RecapResolutionMode } from '../../../shared/protocol'
import type { RecapBundleWriter } from './bundle'
import type { PeriodRecapStore, RecapLogLevel, RecapStatus } from './store'

export interface ProgressBroadcaster {
  broadcast(msg: ProgressMessage | RecapBroadcastMessage | RecapResolvedMessage): void
}

/** EVERYTHING IS A STRUCTURED MESSAGE: resolving a partial recap is a state
 *  change (the reader decided what to do about missing data), so it goes on the
 *  wire like every other one rather than only landing in the store. */
export interface RecapResolvedMessage {
  type: 'recap_resolved'
  recapId: string
  mode: RecapResolutionMode
  resolution: RecapResolution
  meta: unknown
}

export interface ProgressMessage {
  type: 'recap_progress'
  recapId: string
  status: RecapStatus
  progress: number
  phase: string
  log?: { level: RecapLogLevel; message: string; ts: number; data?: unknown }
}

export type RecapBroadcastMessage = {
  type: 'recap_complete'
  recapId: string
  title: string
  markdown: string
  meta: unknown
}

export interface ProgressEmitter {
  emit(level: RecapLogLevel, phase: string, message: string, data?: unknown): void
  setProgress(progress: number, phase: string): void
  setStatus(status: RecapStatus): void
}

export interface ProgressEmitterOptions {
  recapId: string
  store: PeriodRecapStore
  broadcaster: ProgressBroadcaster
  /** Pillar C+: mirror every progress/log line into the bundle's NDJSON trail. */
  bundle?: RecapBundleWriter
}

export function createProgressEmitter(opts: ProgressEmitterOptions): ProgressEmitter {
  let lastStatus: RecapStatus = 'queued'
  let lastProgress = 0
  let lastPhase = ''

  function persist(patch: { status?: RecapStatus; progress?: number; phase?: string }) {
    opts.store.update(opts.recapId, patch)
  }

  function broadcast(log?: ProgressMessage['log']) {
    opts.broadcaster.broadcast({
      type: 'recap_progress',
      recapId: opts.recapId,
      status: lastStatus,
      progress: lastProgress,
      phase: lastPhase,
      ...(log ? { log } : {}),
    })
  }

  return {
    emit(level, phase, message, data) {
      const ts = Date.now()
      opts.store.appendLog({ recapId: opts.recapId, timestamp: ts, level, phase, message, data })
      lastPhase = phase
      opts.bundle?.appendProgress(opts.recapId, {
        kind: 'log',
        ts,
        level,
        phase,
        message,
        ...(data !== undefined ? { data } : {}),
      })
      broadcast({ level, message, ts, data })
    },
    setProgress(progress, phase) {
      lastProgress = clampProgress(progress)
      lastPhase = phase
      persist({ progress: lastProgress, phase: lastPhase })
      opts.bundle?.appendProgress(opts.recapId, {
        kind: 'progress',
        ts: Date.now(),
        progress: lastProgress,
        phase: lastPhase,
      })
      broadcast()
    },
    setStatus(status) {
      lastStatus = status
      persist({ status })
      opts.bundle?.appendProgress(opts.recapId, { kind: 'status', ts: Date.now(), status })
      broadcast()
    },
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

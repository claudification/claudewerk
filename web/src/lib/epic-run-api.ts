/**
 * The `/api/epic` client. Four verbs, no state -- the run artifact is the truth
 * and lives on the sentinel, so nothing here caches it.
 */

import type { EpicCadence } from '@shared/epic-run-types'

export interface EpicRunState {
  epicId: string
  status: 'armed' | 'running' | 'paused' | 'complete' | 'aborted'
  gen: number
  maxGens: number
  /** The `when` axis: every gate the run must pass before it dispatches, ALL of
   *  which must pass on the same beat. Spelled `cadence` in storage and on the
   *  wire; `when` on the verb surface. See `src/shared/epic-when.ts`. */
  cadence: EpicCadence[]
  target: 'pr' | 'merged' | 'shipped'
  concurrency: number
  /** Armed with a planning generation. */
  plan: boolean
  /** Generation 0 has already run -- the engine sets this, and it is what makes
   *  a RESUME skip planning rather than churn a board mid-flight. */
  planned: boolean
  dryGens: number
  abortReason?: string
  digest: string
}

export interface EpicBatonEntry {
  ts: string
  kind: string
  cardId?: string
  body: string
}

export interface EpicRunReply {
  ok: boolean
  error?: string
  run: EpicRunState | null
  baton: EpicBatonEntry[]
}

export interface StartEpicOptions {
  /** One gate, or several -- the route passes it through to the run store, which
   *  normalises either spelling (`epic-when.ts`). Sending the run's existing list
   *  unchanged is what lets a RESUME keep gates the dialog cannot express. */
  cadence: EpicCadence[]
  target: 'pr' | 'merged' | 'shipped'
  concurrency: number
  maxGens?: number
  /** Run a planning generation before anything dispatches. Ignored on a RESUME:
   *  gen 0 already happened and re-planning would churn a live board. */
  plan: boolean
}

async function post(body: Record<string, unknown>): Promise<EpicRunReply> {
  try {
    const res = await fetch('/api/epic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as Partial<EpicRunReply>
    if (!json.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}`, run: null, baton: [] }
    return { ok: true, run: json.run ?? null, baton: json.baton ?? [] }
  } catch (e) {
    return { ok: false, error: (e as Error).message, run: null, baton: [] }
  }
}

export function getEpicRun(project: string, epicId: string): Promise<EpicRunReply> {
  return post({ project, epicId, op: 'get' })
}

export function startEpicRun(project: string, epicId: string, options: StartEpicOptions): Promise<EpicRunReply> {
  return post({ project, epicId, op: 'start', start: options })
}

export function pauseEpicRun(project: string, epicId: string): Promise<EpicRunReply> {
  return post({ project, epicId, op: 'pause' })
}

export function abortEpicRun(project: string, epicId: string, reason: string): Promise<EpicRunReply> {
  return post({ project, epicId, op: 'abort', reason })
}

/**
 * ACKNOWLEDGE a run that has already ended, so it leaves the wall's dimmed tail.
 *
 * NOT an abort and not a delete: the artifact, the baton and every card stay
 * exactly as they are. The sentinel REFUSES this on an armed or running run, so
 * a stray click on an ambient surface can never stop live work.
 */
export function clearEpicRun(project: string, epicId: string): Promise<EpicRunReply> {
  return post({ project, epicId, op: 'clear' })
}

/** Is the run doing anything right now? Drives the button's two faces. */
export function isRunLive(run: EpicRunState | null): boolean {
  return run !== null && (run.status === 'armed' || run.status === 'running')
}

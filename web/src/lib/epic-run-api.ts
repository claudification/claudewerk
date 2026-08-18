/**
 * The `/api/epic` client. Four verbs, no state -- the run artifact is the truth
 * and lives on the sentinel, so nothing here caches it.
 */

export interface EpicRunState {
  epicId: string
  status: 'armed' | 'running' | 'paused' | 'complete' | 'aborted'
  gen: number
  maxGens: number
  cadence: 'now' | 'window'
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
  cadence: 'now' | 'window'
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

/** Is the run doing anything right now? Drives the button's two faces. */
export function isRunLive(run: EpicRunState | null): boolean {
  return run !== null && (run.status === 'armed' || run.status === 'running')
}

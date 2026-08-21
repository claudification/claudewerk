/**
 * The five control-bar VERBS as plain async functions.
 *
 * Split out of the bar so that file stays layout + wiring. Each returns the line
 * to show the user, which is why they are functions and not raw API calls: the
 * useful reply differs per verb (a beat reports what it did, a pause just
 * confirms), and deciding that in JSX would put the interesting part in the
 * least readable place.
 */

import type { EpicRunSnapshot } from '@shared/protocol'
import { beatRun, breakLease } from '@/lib/epic-inspect-api'
import { abortEpicRun, pauseEpicRun, startEpicRun } from '@/lib/epic-run-api'

export type Verb = 'pause' | 'resume' | 'abort' | 'beat' | 'break'

export interface VerbContext {
  project: string
  epicId: string
  run: EpicRunSnapshot | null
}

async function pause({ project, epicId }: VerbContext): Promise<string> {
  const r = await pauseEpicRun(project, epicId)
  return r.ok ? 'paused -- the baton is kept, RESUME picks up here' : r.error || 'pause failed'
}

/**
 * What a RESUME sends back. Every field is carried over from the paused run so a
 * resume changes nothing but the fact of running -- except `plan`, which is
 * forced off: gen 0 already happened, and re-planning would churn a board that
 * is mid-flight.
 *
 * The defaults only apply when the run artifact could not be read, which is the
 * degraded case; they mirror the engine's own defaults so a resume in the dark
 * behaves like a fresh arm rather than something surprising.
 */
export function resumeOptions(run: EpicRunSnapshot | null) {
  return {
    // The run's gates, verbatim: a resume must not quietly drop `queue` (or any
    // future gate the panel does not know about) off an axis it is not editing.
    cadence: run?.cadence ?? ['now'],
    target: run?.target ?? 'merged',
    concurrency: run?.concurrency ?? 3,
    maxGens: run?.maxGens,
    plan: false,
  }
}

async function resume({ project, epicId, run }: VerbContext): Promise<string> {
  const r = await startEpicRun(project, epicId, resumeOptions(run))
  return r.ok ? 'resumed' : r.error || 'resume failed'
}

async function abort({ project, epicId }: VerbContext): Promise<string> {
  const r = await abortEpicRun(project, epicId, 'aborted from the overseer window')
  return r.ok ? 'aborted -- terminal' : r.error || 'abort failed'
}

async function beat({ project, epicId }: VerbContext): Promise<string> {
  const r = await beatRun(project, epicId)
  if (!r.ok) return r.error
  const spawned = r.data?.spawned.length ?? 0
  return `${r.data?.note ?? 'beat done'}${spawned > 0 ? ` -- ${spawned} spawned` : ''}`
}

async function unstick({ project, epicId }: VerbContext): Promise<string> {
  const r = await breakLease(project, epicId, 'broken from the overseer window')
  return r.ok ? r.data : r.error
}

/** Strategy map, per the covenant: five branches on one key is not an if-chain. */
export const VERBS: Record<Verb, (ctx: VerbContext) => Promise<string>> = {
  pause,
  resume,
  abort,
  beat,
  break: unstick,
}

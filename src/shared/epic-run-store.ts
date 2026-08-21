/**
 * The epic run artifact -- `run.md`: flat frontmatter (EpicRunMeta) plus a prose
 * digest body the overseer rewrites each generation ("where this epic stands").
 *
 * Same storage subset as every other artifact here (frontmatter.ts: flat scalars
 * only), and for the same reason -- these files are read by humans mid-run and
 * by a `cat` in a prompt, so nesting would buy nothing and cost legibility.
 *
 * The run file is the ONLY mutable run state. The baton beside it is append-only,
 * and the board cards are owned by the board. Keeping the mutable part small is
 * what makes a crashed generation recoverable: re-read three scalars, re-derive
 * everything else from the board.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { epicDir, epicRunFile, nowIso, safeEpicId } from './epic-paths'
import {
  EPIC_RUN_DEFAULTS,
  type EpicCadence,
  type EpicRunFull,
  type EpicRunMeta,
  type EpicRunStatus,
} from './epic-run-types'
import { parseWhen, serializeWhen } from './epic-when'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'

const STATUSES: readonly EpicRunStatus[] = ['armed', 'running', 'paused', 'complete', 'aborted']
const TARGETS = ['pr', 'merged', 'shipped'] as const

const DEFAULT_DIGEST = '_No digest yet -- the first overseer generation writes it._'

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * The same read for a field that has a FRACTIONAL part. Money does.
 *
 * `num` above parses with `parseInt`, which was correct while every scalar on a
 * run was a counter -- and silently truncates `31.40` to `31` the moment one is
 * not. For the spend ledger that rounds TOWARD ZERO, so the run under-reports
 * what it cost and the cap trips late, which is the one direction a brake must
 * never be wrong in.
 */
function dec(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fallback
}

/** Frontmatter is flat scalars, so a bool may arrive as a real boolean OR as the
 *  string a YAML round-trip left behind. Absent falls back, not to false. */
function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** Alias, deliberately: the on-disk run and the wire run are the same shape. */
export type EpicRun = EpicRunFull

/** Read a run, or null when the epic has never been started. */
export function readEpicRun(root: string, epicId: string): EpicRun | null {
  const file = epicRunFile(root, epicId)
  if (!existsSync(file)) return null
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { meta, body } = parseFrontmatter(content)
  return {
    epicId: typeof meta.epicId === 'string' ? meta.epicId : epicId,
    project: typeof meta.project === 'string' ? meta.project : '',
    // THE `when` AXIS, and the one field here that is not a `pick`: it reads a
    // bare scalar (every run.md written before the axis could hold more than one
    // gate), an inline array, and a joined string, all into one normalised list.
    // A run armed before `queue` existed therefore reads as exactly what it was.
    cadence: parseWhen(meta.cadence),
    status: pick(meta.status, STATUSES, 'armed'),
    gen: num(meta.gen, 0),
    target: pick(meta.target, TARGETS, EPIC_RUN_DEFAULTS.target),
    dryGens: num(meta.dryGens, 0),
    maxGens: num(meta.maxGens, EPIC_RUN_DEFAULTS.maxGens),
    // A run armed before the caps existed carries neither ceiling, and reads as
    // CAPPED AT THE DEFAULT rather than as uncapped. Falling back to 0 would
    // silently grandfather every long-lived run into the exact state this file's
    // ceilings exist to end.
    maxUsd: dec(meta.maxUsd, EPIC_RUN_DEFAULTS.maxUsd),
    maxWallClockMinutes: num(meta.maxWallClockMinutes, EPIC_RUN_DEFAULTS.maxWallClockMinutes),
    spentUsd: dec(meta.spentUsd, 0),
    concurrency: num(meta.concurrency, EPIC_RUN_DEFAULTS.concurrency),
    // A run armed before the planning stage existed carries neither field. It
    // reads as ALREADY PLANNED rather than as owing a plan: retro-fitting a
    // planning generation onto a run that is mid-flight would rewrite a board
    // its own workers are holding open.
    plan: bool(meta.plan, false),
    planned: bool(meta.planned, true),
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    ...(typeof meta.startedAt === 'string' && meta.startedAt ? { startedAt: meta.startedAt } : {}),
    ...(typeof meta.planBaseline === 'string' && meta.planBaseline ? { planBaseline: meta.planBaseline } : {}),
    ...(typeof meta.abortReason === 'string' && meta.abortReason ? { abortReason: meta.abortReason } : {}),
    ...(typeof meta.acknowledgedAt === 'string' && meta.acknowledgedAt ? { acknowledgedAt: meta.acknowledgedAt } : {}),
    digest: body.trim() || DEFAULT_DIGEST,
  }
}

function writeRun(root: string, run: EpicRun): EpicRun {
  mkdirSync(epicDir(root, run.epicId), { recursive: true })
  const { digest, ...meta } = run
  // The gate list goes back as a bare scalar when there is only one of it, so a
  // run that never touched this axis keeps the exact bytes it has always had.
  const frontmatter = { ...meta, cadence: serializeWhen(run.cadence) }
  writeFileSync(epicRunFile(root, run.epicId), serializeFrontmatter(frontmatter, digest), 'utf8')
  return run
}

export interface StartEpicRunInput {
  epicId: string
  project: string
  /**
   * The `when` axis, in whatever spelling the caller sent -- one gate, a list, or
   * a joined string. Normalised by `parseWhen`; absent leaves the run's existing
   * gates alone, which is what makes `start` a merge rather than a clobber.
   */
  cadence?: EpicCadence | EpicCadence[] | string
  target?: EpicRun['target']
  concurrency?: number
  maxGens?: number
  /** Cumulative USD ceiling. `0` disarms it. Honoured on a RESUME too -- raising
   *  it is exactly how a human says "yes, keep going" to a run that parked on
   *  budget, and the alternative would be editing run.md by hand. */
  maxUsd?: number
  /** Minutes-since-first-dispatch ceiling. `0` disarms it. Same resume rule. */
  maxWallClockMinutes?: number
  /** Run a planning generation before beat 1. Only consulted on a FRESH run --
   *  see `startEpicRun` for why a resume never re-plans. */
  plan?: boolean
}

/**
 * Arm a run. Re-arming an existing run RESUMES it (paused/complete -> armed)
 * rather than resetting the generation counter -- the baton already holds those
 * beats, and restarting the count would make two different beats share an id.
 *
 * A RESUME NEVER RE-PLANS, and that is deliberate: gen 0 already ran, the
 * overseer's own replan step covers drift from there, and re-planning would burn
 * a generation churning cards that live workers may be holding open. The `plan`
 * input is therefore only consulted when there is no existing run.
 */
export function startEpicRun(root: string, input: StartEpicRunInput, nowMs: number): EpicRun {
  safeEpicId(input.epicId)
  const ts = nowIso(nowMs)
  const existing = readEpicRun(root, input.epicId)
  const wantsPlan = input.plan ?? EPIC_RUN_DEFAULTS.plan
  const base: EpicRun = existing ?? {
    epicId: input.epicId,
    project: input.project,
    // COPIED, never shared: `EPIC_RUN_DEFAULTS.cadence` is one array instance and
    // handing it to every fresh run would make them all the same object.
    cadence: [...EPIC_RUN_DEFAULTS.cadence],
    status: 'armed',
    gen: 0,
    target: EPIC_RUN_DEFAULTS.target,
    dryGens: 0,
    maxGens: EPIC_RUN_DEFAULTS.maxGens,
    maxUsd: EPIC_RUN_DEFAULTS.maxUsd,
    maxWallClockMinutes: EPIC_RUN_DEFAULTS.maxWallClockMinutes,
    spentUsd: 0,
    concurrency: EPIC_RUN_DEFAULTS.concurrency,
    plan: wantsPlan,
    planned: !wantsPlan,
    created: ts,
    updated: ts,
    digest: DEFAULT_DIGEST,
  }
  return writeRun(root, {
    ...base,
    project: input.project || base.project,
    cadence: input.cadence === undefined ? base.cadence : parseWhen(input.cadence),
    target: input.target ?? base.target,
    concurrency: input.concurrency ?? base.concurrency,
    maxGens: input.maxGens ?? base.maxGens,
    maxUsd: input.maxUsd ?? base.maxUsd,
    maxWallClockMinutes: input.maxWallClockMinutes ?? base.maxWallClockMinutes,
    status: 'armed',
    dryGens: 0,
    // THE CLOCK RESTARTS, THE LEDGER DOES NOT. They are different kinds of fact:
    // wall clock measures the current unattended stretch, so a human resuming a
    // parked run is starting a new one and gets a fresh budget of minutes. Spend
    // is cumulative for the life of the run and re-arming must never launder it
    // -- a run that parked at $100 and resumes unchanged parks again on the next
    // beat, which is the brake working. Raise `maxUsd` to mean "keep going".
    startedAt: undefined,
    updated: ts,
    abortReason: undefined,
    // A RUN THAT STARTED AGAIN IS NEWS AGAIN. Leaving the acknowledgement on a
    // re-armed run would keep it off the wall while it was genuinely running,
    // which is the exact invisibility O2 exists to prevent.
    acknowledgedAt: undefined,
  })
}

export type EpicRunPatch = Partial<Omit<EpicRunMeta, 'epicId' | 'created'>> & { digest?: string }

/** Merge a patch into an existing run. Absent fields are left untouched. */
export function patchEpicRun(root: string, epicId: string, patch: EpicRunPatch, nowMs: number): EpicRun | null {
  const current = readEpicRun(root, epicId)
  if (!current) return null
  return writeRun(root, { ...current, ...patch, updated: nowIso(nowMs) })
}

/** Has this run exhausted its generation ceiling? The runaway backstop. */
export function isOutOfGenerations(run: EpicRun): boolean {
  return run.gen >= run.maxGens
}

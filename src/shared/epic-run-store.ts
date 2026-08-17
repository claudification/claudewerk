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
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'

const CADENCES: readonly EpicCadence[] = ['now', 'window']
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
    cadence: pick(meta.cadence, CADENCES, EPIC_RUN_DEFAULTS.cadence),
    status: pick(meta.status, STATUSES, 'armed'),
    gen: num(meta.gen, 0),
    target: pick(meta.target, TARGETS, EPIC_RUN_DEFAULTS.target),
    dryGens: num(meta.dryGens, 0),
    maxGens: num(meta.maxGens, EPIC_RUN_DEFAULTS.maxGens),
    concurrency: num(meta.concurrency, EPIC_RUN_DEFAULTS.concurrency),
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    ...(typeof meta.abortReason === 'string' && meta.abortReason ? { abortReason: meta.abortReason } : {}),
    digest: body.trim() || DEFAULT_DIGEST,
  }
}

function writeRun(root: string, run: EpicRun): EpicRun {
  mkdirSync(epicDir(root, run.epicId), { recursive: true })
  const { digest, ...meta } = run
  writeFileSync(epicRunFile(root, run.epicId), serializeFrontmatter(meta, digest), 'utf8')
  return run
}

export interface StartEpicRunInput {
  epicId: string
  project: string
  cadence?: EpicCadence
  target?: EpicRun['target']
  concurrency?: number
  maxGens?: number
}

/**
 * Arm a run. Re-arming an existing run RESUMES it (paused/complete -> armed)
 * rather than resetting the generation counter -- the baton already holds those
 * beats, and restarting the count would make two different beats share an id.
 */
export function startEpicRun(root: string, input: StartEpicRunInput, nowMs: number): EpicRun {
  safeEpicId(input.epicId)
  const ts = nowIso(nowMs)
  const existing = readEpicRun(root, input.epicId)
  const base: EpicRun = existing ?? {
    epicId: input.epicId,
    project: input.project,
    cadence: EPIC_RUN_DEFAULTS.cadence,
    status: 'armed',
    gen: 0,
    target: EPIC_RUN_DEFAULTS.target,
    dryGens: 0,
    maxGens: EPIC_RUN_DEFAULTS.maxGens,
    concurrency: EPIC_RUN_DEFAULTS.concurrency,
    created: ts,
    updated: ts,
    digest: DEFAULT_DIGEST,
  }
  return writeRun(root, {
    ...base,
    project: input.project || base.project,
    cadence: input.cadence ?? base.cadence,
    target: input.target ?? base.target,
    concurrency: input.concurrency ?? base.concurrency,
    maxGens: input.maxGens ?? base.maxGens,
    status: 'armed',
    dryGens: 0,
    updated: ts,
    abortReason: undefined,
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

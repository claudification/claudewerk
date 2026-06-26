/**
 * SOTU file-store path derivation.
 *
 * Storage = FILES/JSONL under {cacheDir}/sotu/, NOT SQLite (Decision #3): the
 * access pattern is file-shaped (append a queue, read a whole chronicle), not
 * query-shaped. Layout per the design doc:
 *
 *   {cacheDir}/sotu/<projectSlug>/
 *     queue.jsonl        append-only contributions
 *     chronicle.md       rendered SOTU (human)
 *     chronicle.json     structured chronicle (NOW / JUST-DONE / git-fabric)
 *     state.json         trigger bookkeeping
 *     distills/<ts>/     per-distill artifact bundle (recap C+ pattern)
 *   {cacheDir}/sotu/_fleet/
 *     chronicle.md/.json fleet rollup
 *
 * `_fleet` is a reserved slug; the segment sanitizer keeps project slugs from
 * ever colliding with it or escaping the sotu root.
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectIdentityKey } from '../../shared/project-uri'

/** Reserved slug for the fleet rollup. A project may never normalize to this. */
export const FLEET_SLUG = '_fleet'

let sotuRoot = ''

/** Idempotent: ensure {cacheDir}/sotu/ exists. Call once at broker boot. */
export function initSotuPaths(cacheDir: string): void {
  sotuRoot = resolve(cacheDir, 'sotu')
  mkdirSync(sotuRoot, { recursive: true })
}

/** The sotu root, for tests/diagnostics. Throws if init was skipped. */
export function sotuRootDir(): string {
  if (!sotuRoot) throw new Error('SOTU paths not initialized -- call initSotuPaths(cacheDir) first')
  return sotuRoot
}

/** Normalize an arbitrary project slug to a single safe path segment. Collapses
 *  anything path-unsafe to `-`, strips a leading `_` so a project can never
 *  alias the reserved `_fleet` rollup, and never yields an empty/`.`/`..` segment. */
export function sanitizeSlug(slug: string): string {
  const cleaned = (slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^_+/, '')
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'unknown'
}

/** Derive the SOTU storage slug from a project URI. Uses the system's canonical
 *  `projectIdentityKey` (so the slug agrees with the rest of the broker's project
 *  identity), then `sanitizeSlug` for filesystem safety. The scribe_note handler
 *  and the lifecycle floor both route through this, so a project always maps to
 *  one queue regardless of which seam produced the contribution. */
export function projectSlug(projectUri: string): string {
  return sanitizeSlug(projectIdentityKey(projectUri))
}

/** Per-project directory, created on demand. Pass FLEET_SLUG for the rollup. */
export function projectDir(slug: string): string {
  const seg = slug === FLEET_SLUG ? FLEET_SLUG : sanitizeSlug(slug)
  const dir = join(sotuRootDir(), seg)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function queuePath(slug: string): string {
  return join(projectDir(slug), 'queue.jsonl')
}

export function chronicleJsonPath(slug: string): string {
  return join(projectDir(slug), 'chronicle.json')
}

export function chronicleMdPath(slug: string): string {
  return join(projectDir(slug), 'chronicle.md')
}

export function statePath(slug: string): string {
  return join(projectDir(slug), 'state.json')
}

/** Per-project SOTU spend ledger (Phase 4 budget gate). Tracks day/month USD so
 *  the gate can skip a paid distill once a cap binds. Separate from state.json so
 *  the spend trail survives a pipeline-version reset of the trigger state. */
export function spendPath(slug: string): string {
  return join(projectDir(slug), 'spend.json')
}

/** The distills/ root for a project (recap C+ run-artifact bundle pattern). */
export function distillsRoot(slug: string): string {
  const dir = join(projectDir(slug), 'distills')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A single distill's bundle dir, `distills/<ts>/`. Created on demand. The `ts`
 *  segment is sanitized so a caller can never escape the distills root. */
export function distillDir(slug: string, ts: number | string): string {
  const seg = sanitizeSlug(String(ts))
  const dir = join(distillsRoot(slug), seg)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * config-patch -- apply a broker-pushed `sentinel_patch_config` to the
 * sentinel's in-memory config + on-disk `sentinel.json`.
 *
 * Phase 8 of `.claude/docs/plan-sentinel-profiles.md`. The broker may tune a
 * SUBSET of sentinel config live: per-profile `weight` / `pool` / `label` /
 * `color`, and sentinel-wide `defaultSelection` / `defaultPool`. It may NOT
 * touch `configDir` / `env` / `spawnRoot` (filesystem + credentials, host-only)
 * and may NOT add or remove profiles -- those bind a NAME to a `configDir` and
 * stay CLI-only. Those fields are absent from `SentinelPatchConfig` by design.
 *
 * PERSISTENCE CONTRACT (plan Phase 8, "Persistence on sentinel side"):
 *   1. Validate the patch (unknown profile, weight >= 0, pool shape,
 *      defaultSelection enum, defaultPool shape).
 *   2. Mutate in-memory config.
 *   3. Atomic write of `sentinel.json` (tmp file + rename). Unknown / future
 *      keys are PRESERVED -- we read the raw JSON, splice the tunable fields,
 *      and write the whole object back.
 *   4. On any failure: roll back in-memory, return a structured error.
 *
 * This module is pure-ish: `validateAndApplyPatch` mutates a config object you
 * pass in (the caller owns rollback) and the file write is a separate
 * `atomicWriteRawConfig` so both are unit-testable without a WS connection.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SelectionMode, SentinelPatchConfig } from '../shared/protocol'
import type { SentinelConfig } from './sentinel-config'

/** Pool / profile NAME shape -- mirrors sentinel-config + project-uri. */
const POOL_NAME_RE = /^[a-z0-9-]{1,63}$/

/** Structured failure codes -- mirror `SentinelPatchConfigAck.error`. */
export type PatchErrorCode = 'unknown_profile' | 'invalid_value' | 'io_error'

export interface PatchFailure {
  ok: false
  error: PatchErrorCode
  detail: string
}
export interface PatchSuccess {
  ok: true
}
export type PatchResult = PatchFailure | PatchSuccess

function fail(error: PatchErrorCode, detail: string): PatchFailure {
  return { ok: false, error, detail }
}

function validateSelectionMode(value: unknown): value is SelectionMode {
  return value === 'default' || value === 'balanced' || value === 'random'
}

/**
 * Validate the patch against `config` WITHOUT mutating anything. Returns a
 * `PatchFailure` on the first problem, or `{ ok: true }` when every field is
 * acceptable. Pure -- no side effects, safe to call before touching state.
 *
 * Validation rules (plan Phase 8):
 *   - every patched profile NAME must already exist (never create)
 *   - weight: finite number `>= 0`
 *   - pool: a `[a-z0-9-]{1,63}` string OR `null` (excluded)
 *   - label / color: strings (empty string clears)
 *   - defaultSelection: one of the SelectionMode enum
 *   - defaultPool: a `[a-z0-9-]{1,63}` string that names a pool that will
 *     EXIST after the patch applies (so the broker can't point the fallback at
 *     a vanished pool)
 */
// fallow-ignore-next-line complexity
export function validatePatch(config: SentinelConfig, patch: SentinelPatchConfig): PatchResult {
  // Per-profile field validation. Profile must exist; values must be sane.
  if (patch.profiles) {
    for (const [name, fields] of Object.entries(patch.profiles)) {
      if (!config.profiles[name]) {
        return fail(
          'unknown_profile',
          `profile "${name}" is not configured on this sentinel (known: ${Object.keys(config.profiles).join(', ')})`,
        )
      }
      if (fields.weight !== undefined) {
        if (typeof fields.weight !== 'number' || !Number.isFinite(fields.weight) || fields.weight < 0) {
          return fail('invalid_value', `profile "${name}".weight must be a finite number >= 0`)
        }
      }
      if (fields.pool !== undefined && fields.pool !== null) {
        if (typeof fields.pool !== 'string' || !POOL_NAME_RE.test(fields.pool)) {
          return fail('invalid_value', `profile "${name}".pool must match [a-z0-9-]{1,63} or be null`)
        }
      }
      if (fields.label !== undefined && typeof fields.label !== 'string') {
        return fail('invalid_value', `profile "${name}".label must be a string`)
      }
      if (fields.color !== undefined && typeof fields.color !== 'string') {
        return fail('invalid_value', `profile "${name}".color must be a string`)
      }
    }
  }

  if (patch.defaultSelection !== undefined && !validateSelectionMode(patch.defaultSelection)) {
    return fail('invalid_value', `defaultSelection must be one of "default", "balanced", "random"`)
  }

  if (patch.defaultPool !== undefined) {
    if (typeof patch.defaultPool !== 'string' || !POOL_NAME_RE.test(patch.defaultPool)) {
      return fail('invalid_value', `defaultPool must match [a-z0-9-]{1,63}`)
    }
    // The defaultPool must name a pool that will exist after this patch. Compute
    // the post-patch pool set: start from current pools, fold in any pool the
    // patch assigns to a profile.
    const poolsAfter = new Set<string>()
    for (const [pName, p] of Object.entries(config.profiles)) {
      const patched = patch.profiles?.[pName]
      const nextPool = patched && 'pool' in patched ? patched.pool : p.pool
      if (typeof nextPool === 'string') poolsAfter.add(nextPool)
    }
    if (!poolsAfter.has(patch.defaultPool)) {
      return fail(
        'invalid_value',
        `defaultPool "${patch.defaultPool}" names no pool that would exist after the patch (pools: ${[...poolsAfter].sort().join(', ') || 'none'})`,
      )
    }
  }

  return { ok: true }
}

/**
 * Apply the patch to `config` IN PLACE (mutates `config.profiles[*]` +
 * `config.defaultSelection` / `defaultPool`). Caller MUST have validated first
 * (call `validatePatch`) -- this trusts its input. Returns the list of touched
 * fields for logging.
 */
// fallow-ignore-next-line complexity
export function applyPatchInPlace(
  config: SentinelConfig,
  patch: SentinelPatchConfig,
): Array<{ scope: string; field: string; from: string; to: string }> {
  const touched: Array<{ scope: string; field: string; from: string; to: string }> = []
  const note = (scope: string, field: string, from: unknown, to: unknown) => {
    touched.push({ scope, field, from: String(from ?? '<unset>'), to: String(to ?? '<unset>') })
  }

  if (patch.profiles) {
    for (const [name, fields] of Object.entries(patch.profiles)) {
      const p = config.profiles[name]
      if (fields.weight !== undefined && p.weight !== fields.weight) {
        note(name, 'weight', p.weight, fields.weight)
        p.weight = fields.weight
      }
      if (fields.pool !== undefined && p.pool !== fields.pool) {
        note(name, 'pool', p.pool, fields.pool)
        p.pool = fields.pool
      }
      if (fields.label !== undefined) {
        const next = fields.label === '' ? undefined : fields.label
        if (p.label !== next) {
          note(name, 'label', p.label, next)
          p.label = next
        }
      }
      if (fields.color !== undefined) {
        const next = fields.color === '' ? undefined : fields.color
        if (p.color !== next) {
          note(name, 'color', p.color, next)
          p.color = next
        }
      }
    }
  }

  if (patch.defaultSelection !== undefined && config.defaultSelection !== patch.defaultSelection) {
    note('sentinel', 'defaultSelection', config.defaultSelection, patch.defaultSelection)
    config.defaultSelection = patch.defaultSelection
  }
  if (patch.defaultPool !== undefined && config.defaultPool !== patch.defaultPool) {
    note('sentinel', 'defaultPool', config.defaultPool, patch.defaultPool)
    config.defaultPool = patch.defaultPool
  }

  return touched
}

/**
 * Splice the patch's tunable fields into a RAW config-file object, preserving
 * every other key (unknown / future fields, the secret-bearing `configDir` /
 * `env` / `spawnRoot` we never touch). Returns a NEW object (does not mutate
 * `raw`) ready for `atomicWriteRawConfig`.
 *
 * Profiles only get a sub-object spliced if they already exist in `raw` OR are
 * synthesised (the implicit `default` profile may not be on disk yet). The
 * caller guarantees the patch was validated against the live config, so a
 * patched name that's missing from `raw` is the implicit default -- we create
 * the minimal `{ configDir }`-less entry the loader tolerates by carrying over
 * the live config's resolved values... but we DON'T know the raw configDir, so
 * for a synthesised-default patch we write only the tunable fields under that
 * name and rely on the loader re-synthesising configDir. The default profile
 * never carries a configDir on disk in the implicit case, which is exactly
 * what the loader expects.
 */
// fallow-ignore-next-line complexity
export function spliceRawConfig(raw: Record<string, unknown>, patch: SentinelPatchConfig): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw }

  if (patch.profiles && Object.keys(patch.profiles).length > 0) {
    const rawProfiles =
      raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)
        ? (raw.profiles as Record<string, unknown>)
        : {}
    const profilesOut: Record<string, unknown> = { ...rawProfiles }
    for (const [name, fields] of Object.entries(patch.profiles)) {
      const existing =
        profilesOut[name] && typeof profilesOut[name] === 'object' && !Array.isArray(profilesOut[name])
          ? { ...(profilesOut[name] as Record<string, unknown>) }
          : {}
      if (fields.weight !== undefined) existing.weight = fields.weight
      if (fields.pool !== undefined) existing.pool = fields.pool
      if (fields.label !== undefined) {
        if (fields.label === '') delete existing.label
        else existing.label = fields.label
      }
      if (fields.color !== undefined) {
        if (fields.color === '') delete existing.color
        else existing.color = fields.color
      }
      profilesOut[name] = existing
    }
    next.profiles = profilesOut
  }

  if (patch.defaultSelection !== undefined) next.defaultSelection = patch.defaultSelection
  if (patch.defaultPool !== undefined) next.defaultPool = patch.defaultPool

  return next
}

/** Read the raw config JSON as an untyped object, preserving every key.
 *  A missing / empty file yields `{}` (the implicit-default case). Throws on
 *  malformed JSON so a corrupt file surfaces instead of silently dropping keys. */
// fallow-ignore-next-line complexity
export function readRawConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  const text = readFileSync(configPath, 'utf8').trim()
  if (text.length === 0) return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`sentinel config: ${configPath} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Atomically write `obj` to `configPath`: write to a sibling tmp file, then
 * rename over the target (rename is atomic on the same filesystem). Creates the
 * parent directory if needed. Throws on any IO error -- the caller treats that
 * as `io_error` and rolls back in-memory.
 */
export function atomicWriteRawConfig(configPath: string, obj: Record<string, unknown>): void {
  // sentinel.json can hold long-lived OAuth tokens -- owner-only dir (0700) and
  // file (0600). The tmp file is created 0600 and rename preserves the mode.
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  const tmpPath = join(dirname(configPath), `.${basename(configPath)}.${process.pid}.tmp`)
  const text = `${JSON.stringify(obj, null, 2)}\n`
  writeFileSync(tmpPath, text, { mode: 0o600 })
  renameSync(tmpPath, configPath)
}

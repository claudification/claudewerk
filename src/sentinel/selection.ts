/**
 * selection -- per-spawn sentinel-profile picker.
 *
 * Three modes:
 *   - Fixed:    a literal profile name. Short-circuits to that profile.
 *   - Balanced: from `pooled: true` profiles, pick the one with the fewest
 *               live agent hosts. Ties broken by name (stable).
 *   - Random:   uniform pick over `pooled: true` profiles.
 *
 * No-input spawn falls through to `config.defaultSelection` (default, balanced,
 * or random). Revive NEVER calls this -- revive always pins to a literal name
 * via the URI userinfo (see `case 'revive':` in `src/sentinel/index.ts`).
 *
 * PROFILE-ENV BOUNDARY -- this module returns a `ResolvedProfile` for
 * sentinel-side use. The caller (sentinel spawn handler) reports only the
 * resolved profile NAME back to the broker. Profile env / configDir stay
 * sentinel-side per `.claude/docs/plan-sentinel-profiles.md`.
 */

import type { ResolvedProfile, SentinelConfig } from './sentinel-config'
import { DEFAULT_PROFILE_NAME } from './sentinel-config'

/** Selection-mode token sent on the wire (internal to this module + tests). */
type SelectionToken = 'default' | 'balanced' | 'random'

export interface PickResult {
  profile: ResolvedProfile
  /** Which lane the picker took. `fixed` -- literal name; `balanced` /
   *  `random` -- pooled pick; `default` -- the default profile (config's
   *  defaultSelection was 'default' or balanced/random pool was empty). */
  picker: 'fixed' | 'balanced' | 'random' | 'default'
  /** Pool actually considered (pooled-only for balanced/random; empty for
   *  fixed/default). Useful for logging. */
  pool: string[]
  /** Human-readable reason ("least-active", "random", "fallback:empty-pool",
   *  "literal", "default"). For LOG EVERYTHING covenant compliance. */
  reason: string
}

/**
 * The optional load source. Returns the count of live agent hosts running
 * under each profile on this sentinel. Used only by Balanced. Decoupled so
 * tests can inject deterministic loads.
 */
export type LiveLoadSource = (profileName: string) => number

/** Optional RNG. Injected for deterministic tests. Defaults to `Math.random`. */
export type Rng = () => number

export interface PickOptions {
  /** Selection input from the spawn message: a literal profile name, a
   *  mode token (`'balanced'` / `'random'` / `'default'`), or `undefined`. */
  input?: string
  /** Live load source (sentinel-local). Required for balanced; ignored otherwise. */
  liveLoad?: LiveLoadSource
  /** RNG seam (random only). */
  rand?: Rng
}

/**
 * Pick a profile for a spawn. Throws when `input` is a literal name that's
 * unknown -- the caller translates this to a structured spawn failure.
 */
// fallow-ignore-next-line complexity
export function pickProfile(config: SentinelConfig, opts: PickOptions = {}): PickResult {
  const { input, liveLoad, rand } = opts

  // Literal name -- short-circuit. Validate against the known set.
  if (input && input !== 'default' && input !== 'balanced' && input !== 'random') {
    const profile = config.profiles[input]
    if (!profile) {
      throw new Error(
        `sentinel selection: unknown profile "${input}" (known: ${Object.keys(config.profiles).join(', ')})`,
      )
    }
    return { profile, picker: 'fixed', pool: [], reason: 'literal' }
  }

  // Mode resolution. Absent / 'default' input -> consult defaultSelection.
  // Explicit 'balanced' / 'random' override.
  const mode: SelectionToken = input === 'balanced' || input === 'random' ? input : config.defaultSelection

  if (mode === 'default') {
    return {
      profile: requireProfile(config, DEFAULT_PROFILE_NAME),
      picker: 'default',
      pool: [],
      reason: 'default',
    }
  }

  const pool = pooledProfiles(config)

  if (pool.length === 0) {
    // Empty pool -- fall back to default. Logged so an operator notices a
    // misconfiguration (e.g. every profile marked `pooled: false`).
    return {
      profile: requireProfile(config, DEFAULT_PROFILE_NAME),
      picker: 'default',
      pool: [],
      reason: 'fallback:empty-pool',
    }
  }

  if (mode === 'balanced') {
    const get = liveLoad ?? (() => 0)
    const picked = pickLeastLoaded(pool, get)
    return {
      profile: picked,
      picker: 'balanced',
      pool: pool.map(p => p.name),
      reason: 'least-active',
    }
  }

  // mode === 'random'
  const r = rand ?? Math.random
  const idx = Math.floor(r() * pool.length) % pool.length
  return {
    profile: pool[idx],
    picker: 'random',
    pool: pool.map(p => p.name),
    reason: 'random',
  }
}

function requireProfile(config: SentinelConfig, name: string): ResolvedProfile {
  const profile = config.profiles[name]
  if (!profile) {
    // The default profile is synthesised by loadSentinelConfig -- this is
    // unreachable barring construction-by-hand. Throw loud rather than
    // returning undefined into the caller.
    throw new Error(`sentinel selection: profile "${name}" missing from config (this is a bug)`)
  }
  return profile
}

/** Profiles with `pooled: true`, sorted by name (stable ordering for
 *  tie-breaking and reproducible random with a seeded RNG). */
function pooledProfiles(config: SentinelConfig): ResolvedProfile[] {
  return Object.values(config.profiles)
    .filter(p => p.pooled)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Least-loaded profile from the pool. Ties broken by name (stable since
 *  the pool is pre-sorted by name -- the first profile in iteration order
 *  with the minimum load wins). */
function pickLeastLoaded(pool: ResolvedProfile[], liveLoad: LiveLoadSource): ResolvedProfile {
  let best: ResolvedProfile = pool[0]
  let bestLoad = liveLoad(best.name)
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i]
    const load = liveLoad(candidate.name)
    if (load < bestLoad) {
      best = candidate
      bestLoad = load
    }
  }
  return best
}

/**
 * sentinel-config -- per-host sentinel configuration file (`sentinel.json`).
 *
 * Source of truth for sentinel profiles. The file is sentinel-local; the
 * broker never sees its contents. The broker stores only the profile NAME
 * and display metadata, per the Profile-Env Boundary covenant in
 * `.claude/docs/plan-sentinel-profiles.md`.
 *
 * Defaults:
 *   - Config path: `$XDG_CONFIG_HOME/rclaude/sentinel.json` (i.e. usually
 *     `~/.config/rclaude/sentinel.json`). Override with `--config <path>`.
 *   - Missing file = no profiles configured = today's behaviour (every
 *     spawn runs under the implicit `default` profile, `~/.claude`).
 *
 * The `default` profile is implicit. A sentinel with no `profiles` section
 * (or no file at all) still resolves the name `'default'` to `~/.claude`.
 * Listing `default` explicitly is only useful for overriding its configDir
 * (a non-standard setup) or attaching display metadata.
 *
 * PROFILE-ENV BOUNDARY -- nothing in `SentinelConfig.profiles[*].env` or
 * `.configDir` is allowed to reach broker-side code. `resolveProfile()`
 * returns the full bundle for sentinel-side use; `profileSummaries()`
 * returns the broker-safe slice (NAME + display + auth flag only).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { SelectionMode, SentinelProfileInfo } from '../shared/protocol'

/** Valid profile-name shape -- mirrors `src/shared/project-uri.ts`. */
const PROFILE_NAME_RE = /^[a-z0-9-]{1,63}$/

/** The implicit `default` profile name, used when a spawn carries no profile. */
export const DEFAULT_PROFILE_NAME = 'default'

/** Raw config-file shape (JSON). Optional fields are validated in `loadConfig`. */
export interface SentinelConfigFile {
  /** What the sentinel does on a no-profile spawn. Default `'default'`. */
  defaultSelection?: SelectionMode
  /** Profile registry, keyed by profile name. */
  profiles?: Record<string, SentinelProfileFile>
}

/** Raw profile entry as it appears on disk. Tilde-paths are expanded by the
 *  loader; consumers see absolute paths only. */
export interface SentinelProfileFile {
  configDir: string
  env?: Record<string, string>
  spawnRoot?: string
  pooled?: boolean
  label?: string
  color?: string
}

/**
 * Resolved profile -- absolute paths, normalized fields. This is the bundle
 * the sentinel injects at spawn time. Stays sentinel-side per the
 * Profile-Env Boundary covenant.
 */
export interface ResolvedProfile {
  name: string
  configDir: string
  env: Record<string, string>
  spawnRoot?: string
  pooled: boolean
  label?: string
  color?: string
}

/** Loaded + normalized sentinel config. */
export interface SentinelConfig {
  /** Absolute path the config was loaded from (`null` when no file). */
  sourcePath: string | null
  defaultSelection: SelectionMode
  /** All profiles by name. The `default` profile is always present (synthesised
   *  if the file did not list one). */
  profiles: Record<string, ResolvedProfile>
}

/**
 * Default config path: `$XDG_CONFIG_HOME/rclaude/sentinel.json`, falling back
 * to `~/.config/rclaude/sentinel.json`.
 *
 * The `env` parameter is the test seam.
 */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(xdg, 'rclaude', 'sentinel.json')
}

/**
 * Expand a leading `~` (or `~/...`) into an absolute path. Non-tilde paths
 * are returned untouched -- relative paths stay relative, the caller picks
 * a base when it has one.
 */
function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/** Best-effort auth detection: a profile's configDir holds Claude creds if
 *  either `.credentials.json` or `.claude.json` is non-empty. False otherwise
 *  (the sentinel CLI's `profile auth` flow drives the user to log in). */
// fallow-ignore-next-line complexity
export function profileIsAuthed(configDir: string): boolean {
  for (const name of ['.credentials.json', '.claude.json']) {
    try {
      const path = join(configDir, name)
      if (existsSync(path)) {
        const buf = readFileSync(path, 'utf8')
        if (buf.trim().length > 0) return true
      }
    } catch {
      // unreadable -- treat as unauthed
    }
  }
  return false
}

interface LoadOptions {
  /** Override config path. When undefined, `defaultConfigPath()` is used. */
  configPath?: string
  /** Override `process.env` (test seam). */
  env?: NodeJS.ProcessEnv
  /** Override the home directory (test seam). */
  home?: string
}

/**
 * Load + normalize the sentinel config. Tolerant: a missing file or empty
 * file yields a config with only the implicit `default` profile. Validation
 * errors throw with a precise message -- the operator needs to know.
 */
export function loadSentinelConfig(opts: LoadOptions = {}): SentinelConfig {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const configPath = opts.configPath ?? defaultConfigPath(env, home)

  const { raw, sourcePath } = readConfigFile(configPath)
  const defaultSelection = validateSelectionMode(raw.defaultSelection, configPath)
  const profiles = buildProfileMap(raw.profiles, configPath, home)
  return { sourcePath, defaultSelection, profiles }
}

/** Read + parse the JSON config file. Tolerates missing / empty file. */
// fallow-ignore-next-line complexity
function readConfigFile(configPath: string): { raw: SentinelConfigFile; sourcePath: string | null } {
  if (!existsSync(configPath)) return { raw: {}, sourcePath: null }
  let buf: string
  try {
    buf = readFileSync(configPath, 'utf8')
  } catch (e) {
    throw new Error(`sentinel config: failed to read ${configPath}: ${(e as Error).message}`)
  }
  const trimmed = buf.trim()
  // Empty file -- treat as if absent so the operator's `touch` does no harm.
  if (trimmed.length === 0) return { raw: {}, sourcePath: configPath }
  let raw: SentinelConfigFile
  try {
    raw = JSON.parse(trimmed) as SentinelConfigFile
  } catch (e) {
    throw new Error(`sentinel config: invalid JSON in ${configPath}: ${(e as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`sentinel config: ${configPath} must be a JSON object`)
  }
  return { raw, sourcePath: configPath }
}

/** Validate + normalize every profile in the raw map; synthesise `default`. */
// fallow-ignore-next-line complexity
function buildProfileMap(
  rawProfiles: SentinelConfigFile['profiles'],
  configPath: string,
  home: string,
): Record<string, ResolvedProfile> {
  const safeProfiles = rawProfiles ?? {}
  if (typeof safeProfiles !== 'object' || safeProfiles === null || Array.isArray(safeProfiles)) {
    throw new Error(`sentinel config: "profiles" in ${configPath} must be an object keyed by profile name`)
  }
  const profiles: Record<string, ResolvedProfile> = {}
  for (const [name, entry] of Object.entries(safeProfiles)) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(`sentinel config: profile name "${name}" in ${configPath} must match [a-z0-9-]{1,63}`)
    }
    profiles[name] = normalizeProfile(name, entry, home, configPath)
  }
  // `default` is implicit: synthesise it if the file did not list it. This is
  // what makes the no-profile-config case behave exactly as today.
  if (!profiles[DEFAULT_PROFILE_NAME]) {
    profiles[DEFAULT_PROFILE_NAME] = {
      name: DEFAULT_PROFILE_NAME,
      configDir: join(home, '.claude'),
      env: {},
      pooled: true,
    }
  }
  return profiles
}

// fallow-ignore-next-line complexity
function validateSelectionMode(value: unknown, configPath: string): SelectionMode {
  if (value === undefined) return 'default'
  if (value === 'default' || value === 'balanced' || value === 'random') return value
  throw new Error(
    `sentinel config: defaultSelection in ${configPath} must be one of "default", "balanced", "random" (got ${JSON.stringify(value)})`,
  )
}

// fallow-ignore-next-line complexity
function normalizeProfile(
  name: string,
  raw: SentinelProfileFile | undefined,
  home: string,
  configPath: string,
): ResolvedProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`sentinel config: profile "${name}" in ${configPath} must be an object`)
  }
  if (typeof raw.configDir !== 'string' || raw.configDir.length === 0) {
    throw new Error(`sentinel config: profile "${name}" in ${configPath} requires a non-empty "configDir"`)
  }
  return {
    name,
    configDir: resolvePath(expandTilde(raw.configDir, home)),
    env: validateProfileEnv(name, raw.env, configPath),
    spawnRoot: validateSpawnRoot(name, raw.spawnRoot, home, configPath),
    pooled: raw.pooled !== undefined ? Boolean(raw.pooled) : true,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    color: typeof raw.color === 'string' ? raw.color : undefined,
  }
}

// fallow-ignore-next-line complexity
function validateProfileEnv(
  name: string,
  rawEnv: Record<string, string> | undefined,
  configPath: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (rawEnv === undefined) return env
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error(`sentinel config: profile "${name}".env in ${configPath} must be a string->string object`)
  }
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof v !== 'string') {
      throw new Error(
        `sentinel config: profile "${name}".env["${k}"] in ${configPath} must be a string (got ${typeof v})`,
      )
    }
    env[k] = v
  }
  return env
}

function validateSpawnRoot(
  name: string,
  rawSpawnRoot: string | undefined,
  home: string,
  configPath: string,
): string | undefined {
  if (rawSpawnRoot === undefined) return undefined
  if (typeof rawSpawnRoot !== 'string' || rawSpawnRoot.length === 0) {
    throw new Error(`sentinel config: profile "${name}".spawnRoot in ${configPath} must be a non-empty string`)
  }
  return resolvePath(expandTilde(rawSpawnRoot, home))
}

/**
 * Resolve a profile name (or absent) to its bundle. Used by the revive path,
 * which always carries a literal name (the broker strips mode tokens at
 * spawn_result time per Phase 3).
 *
 * Selection-mode tokens (`balanced`, `random`) are NOT a valid revive input.
 * The sentinel's revive handler converts any such token to `undefined` and
 * logs a WARN before calling this function -- so a token reaching here is a
 * caller-side bug; fall back to `default` defensively.
 *
 * Spawn paths use `pickProfile()` in `selection.ts` instead, which knows how
 * to dispatch literal vs. balanced vs. random.
 *
 * Throws when a literal name is given and the profile is unknown -- catch
 * this at the spawn / revive boundary and translate to a structured failure.
 */
// fallow-ignore-next-line complexity
export function resolveProfile(config: SentinelConfig, name?: string): ResolvedProfile {
  if (!name || name === DEFAULT_PROFILE_NAME) return config.profiles[DEFAULT_PROFILE_NAME]
  if (name === 'balanced' || name === 'random') {
    // Defensive: the revive guard converts these to undefined before calling.
    return config.profiles[DEFAULT_PROFILE_NAME]
  }
  const profile = config.profiles[name]
  if (!profile) {
    throw new Error(`sentinel config: unknown profile "${name}" (known: ${Object.keys(config.profiles).join(', ')})`)
  }
  return profile
}

/** Active configDir for a (possibly absent) profile name. Thin convenience
 *  wrapper around `resolveProfile` -- prefer this when you only need the path. */
export function configDirFor(config: SentinelConfig, name?: string): string {
  return resolveProfile(config, name).configDir
}

/**
 * The broker-safe slice of profile data -- NAME + display + pooled + authed.
 * NEVER includes configDir or env. Used to build `SentinelIdentify.profiles`.
 *
 * Per the Profile-Env Boundary covenant: the broker stores the profile NAME
 * registry, never the resolved env. Sending `configDir` or `profile.env` over
 * the wire is a covenant violation.
 */
export function profileSummaries(config: SentinelConfig): SentinelProfileInfo[] {
  return Object.values(config.profiles)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => ({
      name: p.name,
      label: p.label,
      color: p.color,
      pooled: p.pooled,
      authed: profileIsAuthed(p.configDir),
    }))
}

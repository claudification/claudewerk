/**
 * Sentinel profile/auth env helpers shared by the headless and PTY spawn paths.
 * Extracted from `index.ts` so they are unit-testable without importing the
 * sentinel entrypoint (which self-executes on import).
 */

import type { ResolvedProfile } from './sentinel-config'

/**
 * FILE-AUTH MODE (force file-based credentials for every profile).
 *
 * Setting `CLAUDE_CONFIG_DIR` -- even to the implicit default `~/.claude` --
 * puts CC into "custom configDir" mode: it reads/writes credentials from
 * `<configDir>/.credentials.json` and SKIPS the macOS Keychain. We WANT that
 * for every profile, because the file holds the full-scope `/login` token
 * (`user:profile` + `user:sessions:claude_code` + `user:inference`) -- so
 * interactive, usage polling, and inference all work, keychain-independent,
 * one account per configDir.
 *
 * REQUIREMENT: every profile's `configDir` MUST contain a valid
 * `.credentials.json` (run `CLAUDE_CONFIG_DIR=<dir> claude` and `/login`, which
 * writes the file in this mode). With the var set and NO file present, CC skips
 * the keychain, finds nothing, and reports "Not logged in" -- so provision the
 * file first.
 *
 * Inject whenever a configDir is resolved (always, incl. the default).
 */
export function shouldInjectConfigDir(configDir: string | undefined): configDir is string {
  return !!configDir
}

/**
 * Names of the auth/profile/custom env vars that MUST cross the tmux boundary
 * as REAL env vars on the PTY agent-host process.
 *
 * Why this exists: the headless path is a direct `Bun.spawn` whose child
 * inherits the env object verbatim. The PTY path goes through tmux, and a new
 * tmux window/pane inherits the tmux SERVER's (stale) environment -- NOT the
 * env we hand to `revive-session.sh`. So `CLAUDE_CONFIG_DIR` + `profile.env`
 * (set in `scriptEnv`/`reviveEnv`) silently evaporated at the seam, and
 * profiled PTY conversations could not authenticate (PTY auth relies entirely
 * on the configDir's `.credentials.json` -- see `shouldInjectConfigDir`).
 *
 * The fix: hand `revive-session.sh` the LIST OF NAMES (names are not secret).
 * The script re-exports each via `tmux new-window -e "$name=$value"`, reading
 * the value from its own process env. `-e` takes the value literally (no shell
 * parsing -> no injection) and is scoped to the new window (verified: it does
 * NOT leak to sibling windows the way `set-environment -g`/`new-session -e`
 * would). Values never touch disk, a log, or a shell command string.
 *
 * Returns a space-separated string (env var names are `[A-Za-z_][A-Za-z0-9_]*`,
 * so whitespace-splitting in bash is safe). Empty string -> the default-profile
 * PTY path is unchanged (no keys to forward).
 */
export function ptyCrossBoundaryEnvKeys(
  profile: ResolvedProfile | undefined,
  customEnv: Record<string, string> | undefined,
  /** Extra var names the caller set on the PTY env that must also survive the
   *  tmux seam (e.g. CLAUDWERK_THINKING_DISPLAY). Names only -- same contract. */
  extraKeys: readonly string[] = [],
): string {
  const keys: string[] = []
  if (shouldInjectConfigDir(profile?.configDir)) keys.push('CLAUDE_CONFIG_DIR')
  if (profile?.env) keys.push(...Object.keys(profile.env))
  // RCLAUDE_CUSTOM_ENV is a single JSON blob read by the agent host
  // (cli-args.ts) from process.env -- it too must survive the tmux boundary.
  if (customEnv && Object.keys(customEnv).length) keys.push('RCLAUDE_CUSTOM_ENV')
  keys.push(...extraKeys)
  return keys.join(' ')
}

/**
 * The `CLAUDWERK_PTY_ENV_KEYS` env entry to spread into a PTY spawn/revive env,
 * or `{}` when there is nothing to forward. Both tmux paths (spawn + revive)
 * build it identically -- having one helper keeps them from drifting and
 * computes the key list ONCE instead of per-spread.
 */
export function ptyCrossBoundaryEnvEntry(
  profile: ResolvedProfile | undefined,
  customEnv: Record<string, string> | undefined,
  extraKeys: readonly string[] = [],
): { CLAUDWERK_PTY_ENV_KEYS?: string } {
  const keys = ptyCrossBoundaryEnvKeys(profile, customEnv, extraKeys)
  return keys ? { CLAUDWERK_PTY_ENV_KEYS: keys } : {}
}

/**
 * The complete profile/custom-env tail of a PTY spawn OR revive env, spread as
 * one block. Both tmux paths need exactly this and nothing about it differs
 * between them, so it lives here rather than being copy-pasted into each:
 *
 *  - `RCLAUDE_CUSTOM_ENV` -- user env as a single JSON blob (read by cli-args).
 *  - `CLAUDE_CONFIG_DIR`  -- injected DIRECTLY so revive-session.sh, the tmux
 *    child, and the rclaude binary all see it as real env. Skipped for the
 *    implicit `~/.claude` default so CC's Keychain fallback still fires.
 *  - `profile.env`        -- e.g. ANTHROPIC_API_KEY for an alt account.
 *    PROFILE-ENV BOUNDARY: these values are never echoed over the wire.
 *  - `CLAUDWERK_PTY_ENV_KEYS` -- the NAMES revive-session.sh re-exports across
 *    the tmux seam (a new pane inherits the tmux server's stale env, not this).
 */
export function ptyProfileEnvBlock(
  profile: ResolvedProfile | undefined,
  customEnv: Record<string, string> | undefined,
  extraKeys: readonly string[] = [],
): Record<string, string> {
  return {
    ...(customEnv && Object.keys(customEnv).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(customEnv) } : {}),
    ...(shouldInjectConfigDir(profile?.configDir) ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
    ...(profile?.env ?? {}),
    ...ptyCrossBoundaryEnvEntry(profile, customEnv, extraKeys),
  }
}

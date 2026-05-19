/**
 * `claudeConfigDir()` -- the directory Claude Code reads its OAuth token,
 * `settings.json`, MCP server registrations, projects/transcripts and user
 * `CLAUDE.md` from. Defaults to `~/.claude`; overridden by the
 * `CLAUDE_CONFIG_DIR` env var.
 *
 * This helper exists so any code that needs to discover transcripts, settings
 * or credentials reads from the SAME dir that the spawned `claude` CLI does.
 * A sentinel profile (see `.claude/docs/plan-sentinel-profiles.md`) sets
 * `CLAUDE_CONFIG_DIR` for the spawned agent host AND the `claude` child it
 * forks; both then read from the profile's configDir instead of `~/.claude`.
 *
 * BROKER-SIDE CODE MUST NEVER CALL THIS. The broker doesn't see the
 * filesystem. Profile env is sentinel-side per the Profile-Env Boundary
 * covenant.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the active Claude config directory.
 *
 * - If `CLAUDE_CONFIG_DIR` is set in env (a sentinel profile injected it),
 *   that wins.
 * - Otherwise `~/.claude`, matching CC's own default.
 *
 * The `env` parameter is the test seam -- production callers omit it and the
 * helper reads `process.env`.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR
  if (override && override.length > 0) return override
  return join(homedir(), '.claude')
}

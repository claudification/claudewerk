/**
 * Resolve the Claude Code daemon control socket path.
 *
 * The daemon is transient -- it idle-exits when the last client/lease drops --
 * so "not found" is a normal state, not an error. Callers treat `null` as
 * "no daemon reachable right now".
 *
 * Socket dir layout: `/tmp/cc-daemon-<uid>/<instance>/control.sock`.
 *
 * Per-profile routing: cc-daemon is one-per-`CLAUDE_CONFIG_DIR` -- different
 * profiles (e.g. default vs `work`) spawn separate daemons, each keeping its
 * own `roster.json` under its own config dir. Callers that handle multiple
 * profiles in the same process MUST pass the profile env explicitly; an
 * absent env arg uses `process.env` and enables the per-uid scan fallback
 * (legacy single-profile behavior). An explicit env arg disables scan
 * fallback -- the per-uid `/tmp` tree cannot disambiguate between
 * profile-isolated daemons, so a fallback there would risk routing to the
 * wrong profile's daemon.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeConfigDir } from '../claude-config-dir'

/**
 * Path to the daemon `roster.json` under the ACTIVE config dir. Honors
 * `CLAUDE_CONFIG_DIR` so a profile-isolated daemon's roster is found instead
 * of always reading `~/.claude/daemon/roster.json`. `env` is the test seam.
 */
export function rosterPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), 'daemon', 'roster.json')
}

/**
 * Resolve `control.sock`, or `null` if no daemon is reachable. When `env` is
 * passed, only the matching profile's roster is consulted (strict mode --
 * no scan fallback, which would risk wrong-profile routing).
 */
export function resolveControlSocket(env?: NodeJS.ProcessEnv): string | null {
  const dir = resolveSockDir(env)
  if (!dir) return null
  const sock = join(dir, 'control.sock')
  return existsSync(sock) ? sock : null
}

/**
 * Resolve the daemon socket directory `/tmp/cc-daemon-<uid>/<instance>`.
 * Strict when `env` is explicit (roster only); legacy roster-then-scan when
 * called bare (back-compat for single-profile callers).
 */
export function resolveSockDir(env?: NodeJS.ProcessEnv): string | null {
  const fromRoster = sockDirFromRoster(rosterPath(env ?? process.env))
  if (fromRoster) return fromRoster
  // Scan fallback is single-profile-only. With env explicit, the caller is
  // profile-aware -- guessing across the per-uid tree can route to the wrong
  // daemon, so fail loudly (null) instead.
  return env === undefined ? sockDirFromScan() : null
}

/** Parsed shape of the bits of `roster.json` we read. */
export interface RosterShape {
  workers?: Record<string, { rendezvousSock?: string; ptySock?: string } | undefined>
}

/**
 * Resolve a worker's `ptySock` -- the per-worker socket carrying the framed
 * `[len:u32be][kind:u8]` PTY duplex. `null` if the worker (or the roster) is
 * absent. Pure read of `roster.json`. `env` selects which profile's roster.
 */
export function resolveWorkerPtySock(short: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const roster = JSON.parse(readFileSync(rosterPath(env), 'utf8')) as RosterShape
    return roster.workers?.[short]?.ptySock ?? null
  } catch {
    return null
  }
}

/**
 * Derive the daemon sock dir from a parsed roster object. Pure -- the file
 * read lives in `sockDirFromRoster`. A worker's `rendezvousSock` is
 * `<dir>/rv/<short>.sock`, so the sock dir is two path segments up.
 */
export function sockDirFromRosterData(roster: RosterShape): string | null {
  const sock = Object.values(roster.workers ?? {}).find(w => w?.rendezvousSock)?.rendezvousSock
  return sock ? join(sock, '..', '..') : null
}

/** roster.json carries absolute worker socket paths; the sock dir is two up. */
function sockDirFromRoster(path: string): string | null {
  try {
    return sockDirFromRosterData(JSON.parse(readFileSync(path, 'utf8')) as RosterShape)
  } catch {
    // roster absent or unparseable -- daemon may be down. Treat as not found.
    return null
  }
}

/** The per-uid daemon base dir `/tmp/cc-daemon-<uid>`, or null off Unix. */
function uidBaseDir(): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return uid == null ? null : `/tmp/cc-daemon-${uid}`
}

/** `readdirSync` that yields `[]` instead of throwing on a missing dir. */
function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** mtime of `<dir>/control.sock`, or null if it has no reachable socket. */
function controlSockMtime(dir: string): number | null {
  const sock = join(dir, 'control.sock')
  if (!existsSync(sock)) return null
  try {
    return statSync(sock).mtimeMs
  } catch {
    return null // socket vanished between readdir and stat
  }
}

/** Instance dirs under `base` that hold a control socket, newest mtime first. */
function scanControlDirs(base: string): { dir: string; mtimeMs: number }[] {
  const found: { dir: string; mtimeMs: number }[] = []
  for (const name of readDirSafe(base)) {
    const dir = join(base, name)
    const mtimeMs = controlSockMtime(dir)
    if (mtimeMs != null) found.push({ dir, mtimeMs })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Fallback when the daemon is up with zero workers: scan the per-uid base dir. */
function sockDirFromScan(): string | null {
  const base = uidBaseDir()
  if (!base) return null
  return scanControlDirs(base)[0]?.dir ?? null
}

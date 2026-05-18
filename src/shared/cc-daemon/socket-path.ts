/**
 * Resolve the Claude Code daemon control socket path.
 *
 * The daemon is transient -- it idle-exits when the last client/lease drops --
 * so "not found" is a normal state, not an error. Callers treat `null` as
 * "no daemon reachable right now".
 *
 * Socket dir layout: `/tmp/cc-daemon-<uid>/<instance>/control.sock`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROSTER_PATH = join(homedir(), '.claude', 'daemon', 'roster.json')

/** Resolve `control.sock`, or `null` if no daemon is reachable. */
export function resolveControlSocket(): string | null {
  const dir = resolveSockDir()
  if (!dir) return null
  const sock = join(dir, 'control.sock')
  return existsSync(sock) ? sock : null
}

/** Resolve the daemon socket directory `/tmp/cc-daemon-<uid>/<instance>`. */
export function resolveSockDir(): string | null {
  // Authoritative: derive from a live worker's socket path in roster.json.
  return sockDirFromRoster() ?? sockDirFromScan()
}

/** Parsed shape of the bits of `roster.json` we read. */
export interface RosterShape {
  workers?: Record<string, { rendezvousSock?: string; ptySock?: string } | undefined>
}

/**
 * Resolve a worker's `ptySock` -- the per-worker socket carrying the framed
 * `[len:u32be][kind:u8]` PTY duplex. `null` if the worker (or the roster) is
 * absent. Pure read of `roster.json`.
 */
export function resolveWorkerPtySock(short: string): string | null {
  try {
    const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as RosterShape
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
function sockDirFromRoster(): string | null {
  try {
    return sockDirFromRosterData(JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as RosterShape)
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

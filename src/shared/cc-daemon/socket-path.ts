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

/** roster.json carries absolute worker socket paths; the sock dir is two up. */
function sockDirFromRoster(): string | null {
  try {
    const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as {
      workers?: Record<string, { rendezvousSock?: string }>
    }
    for (const worker of Object.values(roster.workers ?? {})) {
      // `<dir>/rv/<short>.sock` -> `<dir>`
      if (worker?.rendezvousSock) return join(worker.rendezvousSock, '..', '..')
    }
  } catch {
    // roster absent or unparseable -- daemon may be down. Fall through.
  }
  return null
}

/** Fallback when the daemon is up with zero workers: scan the per-uid base dir. */
function sockDirFromScan(): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid == null) return null
  const base = `/tmp/cc-daemon-${uid}`
  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch {
    return null
  }
  let newest: { dir: string; mtimeMs: number } | null = null
  for (const name of entries) {
    const dir = join(base, name)
    const sock = join(dir, 'control.sock')
    if (!existsSync(sock)) continue
    try {
      const { mtimeMs } = statSync(sock)
      if (!newest || mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs }
    } catch {
      // socket vanished between readdir and stat -- skip.
    }
  }
  return newest?.dir ?? null
}

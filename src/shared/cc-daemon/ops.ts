/**
 * Typed wrappers for the daemon control ops.
 *
 * Read-only/discovery ops (`ping`, `list`, `has`, `leases`) drive the Phase 1
 * read-only mirror. The mutating ops (`resize`, `kill`, `reply`,
 * `respawnStale`, `lease`) drive Phase 2/3 remote control -- every request
 * shape here is recovered from the 2.1.143 daemon schema; `resize` is
 * additionally live-verified. The streaming ops live in their own modules
 * (`subscribe.ts`, `attach.ts`); the socket `dispatch` op is Phase 3.
 */
import { request } from './client'
import type { DaemonResponse, ListResponse } from './types'

/** Liveness check. Not proto-gated -- always answers. */
export function ping(sockPath: string): Promise<DaemonResponse> {
  return request(sockPath, { op: 'ping' })
}

/** List every background job the daemon knows about. */
export async function list(sockPath: string): Promise<ListResponse> {
  const resp = await request(sockPath, { op: 'list' })
  if (resp.ok === false) throw new Error(`cc-daemon: list failed: ${resp.error}`)
  return resp as ListResponse
}

/** Check whether a job exists and whether its process is alive. */
export function has(sockPath: string, short: string): Promise<DaemonResponse> {
  return request(sockPath, { op: 'has', short })
}

/** List active client leases holding the daemon open. */
export function leases(sockPath: string): Promise<DaemonResponse> {
  return request(sockPath, { op: 'leases' })
}

/** A client lease registration -- identifies who is holding the daemon open. */
export interface LeaseClient {
  label: string
  cwd: string
  pid: number
}

/**
 * Register a lease that holds the transient daemon open. The daemon idle-exits
 * once leases AND workers both drop, so the sentinel keeps one of these.
 * Pre-gate: survives a CC-version protocol mismatch.
 */
export function lease(sockPath: string, client: LeaseClient): Promise<DaemonResponse> {
  return request(sockPath, { op: 'lease', client })
}

/**
 * Resize a worker PTY. With `attachId` it resizes just that attacher's view;
 * without, it resizes the worker PTY itself. Live-verified.
 */
export function resize(
  sockPath: string,
  short: string,
  cols: number,
  rows: number,
  attachId?: string,
): Promise<DaemonResponse> {
  return request(
    sockPath,
    attachId ? { op: 'resize', short, cols, rows, attachId } : { op: 'resize', short, cols, rows },
  )
}

/**
 * Inject `text` into a worker as a turn, without attaching. Mutating.
 *
 * SPIKED LIVE 2026-05-20 (Spike 6): the daemon accepts `reply` against both
 * `running` (busy) and `done` workers -- `{ok:true, op:'reply'}` in both
 * cases. No ENOREPLY boundary surfaced for these states. `failed` and
 * `idle` boundaries are deferred -- a fresh Haiku worker quickly transitions
 * `starting -> running -> done`, so reaching them deterministically in a
 * short spike was not possible.
 */
export function reply(sockPath: string, short: string, text: string): Promise<DaemonResponse> {
  return request(sockPath, { op: 'reply', short, text })
}

/** Terminate a worker. `signal` defaults to SIGTERM daemon-side. Mutating. */
export function kill(sockPath: string, short: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<DaemonResponse> {
  return request(sockPath, signal ? { op: 'kill', short, signal } : { op: 'kill', short })
}

/**
 * Respawn a worker that has gone idle-stale -- the native fix for the
 * "worker shows `failed` after sleep/wake" case. Mutating.
 */
export function respawnStale(sockPath: string, short: string): Promise<DaemonResponse> {
  return request(sockPath, { op: 'respawn-stale', short })
}

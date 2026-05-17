/**
 * Typed wrappers for the read-only daemon control ops used in Phase 1
 * (the read-only mirror). Mutating ops (reply, kill, dispatch, ...) and
 * streaming ops (subscribe, attach) arrive in later phases.
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

import { projectIdentityKey } from '@shared/project-uri'
import { useEffect, useSyncExternalStore } from 'react'
import { createExternalStoreSignal } from './external-store-utils'
import { wsSend } from './use-conversations'

/**
 * Per-project commit aggregates for the PLACE card -- "what has ever landed
 * here, by anyone", as opposed to the RUN card's "what did this agent land".
 *
 * The broker keeps the numbers in an in-memory map (commit-ledger/project-counts)
 * so a request is a map read, not a query. One request seeds the first hover;
 * after that every ingest PUSHES a fresh `project_commit_stats` frame, which is
 * the invalidation: a cached aggregate that nothing invalidates on ingest is
 * exactly the bug that made commit counts stale on reload (5440d54d).
 */

export interface ProjectCommitStats {
  total: number
  agent: number
  human: number
  today: number
  lastCommittedAt: number | null
}

const signal = createExternalStoreSignal()
const cache = new Map<string, ProjectCommitStats>()
const requested = new Set<string>()

/** WS push sink -- called from the dashboard message handlers. */
export function applyProjectCommitStats(project: string, stats: ProjectCommitStats): void {
  cache.set(projectIdentityKey(project), stats)
  signal.bump()
}

/** Dropped on reconnect: the broker may have restarted and rebuilt its map. */
export function resetProjectCommitStatsCache(): void {
  cache.clear()
  requested.clear()
  signal.bump()
}

export function useProjectCommitStats(projectUri: string | null): ProjectCommitStats | null {
  useEffect(() => {
    if (!projectUri) return
    const key = projectIdentityKey(projectUri)
    if (requested.has(key)) return
    // Only remember the ask if it actually went out -- a send while the socket
    // is down would otherwise leave this project permanently unseeded.
    if (wsSend('project_commit_stats_request', { project: projectUri })) requested.add(key)
  }, [projectUri])

  useSyncExternalStore(signal.subscribe, signal.getVersion, signal.getVersion)
  if (!projectUri) return null
  return cache.get(projectIdentityKey(projectUri)) ?? null
}

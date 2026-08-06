import { projectIdentityKey } from '@shared/project-uri'
import { useEffect, useSyncExternalStore } from 'react'
import { createExternalStoreSignal } from './external-store-utils'
import { wsSend } from './use-conversations'

/**
 * The PLACE card's INTEGRATION line: what the LAST git scan said about this
 * project's branches, and how old that answer is.
 *
 * READ ONLY. The broker handler reads the stored snapshot and derives -- it
 * never scans and never distills. The card shows the snapshot's age rather than
 * refreshing it, because a scan-on-hover is a 15s sentinel round trip (and,
 * through `sotu_view`, a paid distill) behind every pointer move down a list.
 */

export interface ProjectIntegration {
  unpushed: number
  stalled: number
  dirty: number
  conflicts: number
  branches: number
  scannedAt: number | null
  fetchedAt: number | null
}

/** How stale a snapshot may be before a hover asks the broker again. The scan
 *  itself is floored at minutes, so asking more often just burns round trips. */
const TTL_MS = 120_000

const signal = createExternalStoreSignal()
const cache = new Map<string, { at: number; value: ProjectIntegration }>()

/** WS reply sink -- called from the dashboard message handlers. */
export function applyProjectIntegration(project: string, integration: ProjectIntegration): void {
  cache.set(projectIdentityKey(project), { at: Date.now(), value: integration })
  signal.bump()
}

/** Dropped on reconnect: a new broker process may hold a different snapshot. */
export function resetProjectIntegrationCache(): void {
  cache.clear()
  signal.bump()
}

export function useProjectIntegration(projectUri: string | null): ProjectIntegration | null {
  useEffect(() => {
    if (!projectUri) return
    const hit = cache.get(projectIdentityKey(projectUri))
    if (hit && Date.now() - hit.at < TTL_MS) return
    wsSend('project_integration_request', { project: projectUri })
  }, [projectUri])

  useSyncExternalStore(signal.subscribe, signal.getVersion, signal.getVersion)
  if (!projectUri) return null
  return cache.get(projectIdentityKey(projectUri))?.value ?? null
}

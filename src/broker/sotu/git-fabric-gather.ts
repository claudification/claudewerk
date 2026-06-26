/**
 * Broker-side git-fabric gatherer (SOTU Phase 2). The SOTU module is
 * broker-internal but must NOT touch the host filesystem (boundary rule) -- it
 * asks the sentinel that owns the project to run the integration ladder via the
 * `git_fabric_request` RPC and returns the structured `GitFabric` snapshot.
 *
 * Mirrors `recap/commit-gather.ts` exactly: pick the owning sentinel by the URI
 * authority, send the request, await the `git_fabric_result` keyed by requestId.
 * It rides the GENERIC requestId-keyed file listener (the same seam `fetchArtifact`
 * reuses) so no per-RPC listener registry is needed.
 *
 * Injectable transport keeps it unit-testable with a fake sentinel.
 */

import { randomUUID } from 'node:crypto'
import { parseProjectUri } from '../../shared/project-uri'
import type { GitFabric, GitFabricRequest, GitFabricResult } from '../../shared/protocol'

const GIT_FABRIC_TIMEOUT_MS = 15_000

interface SentinelHandle {
  send: (data: string) => void
}

/** The minimal slice of ConversationStore the gatherer needs -- the sentinel
 *  getters + the generic requestId-keyed file listener (result == arbitrary JSON). */
export interface GitFabricTransport {
  getSentinelByAlias: (alias: string) => SentinelHandle | undefined
  getSentinel: () => SentinelHandle | undefined
  addFileListener: (requestId: string, cb: (result: unknown) => void) => void
  removeFileListener: (requestId: string) => void
}

export interface GatherFabricResult {
  fabric?: GitFabric
  error?: string
}

/** Request the git-fabric snapshot for one project. Picks the owning sentinel by
 *  the URI authority (the broker never resolves URI->path -- CWD-IS-INFORMATIONAL),
 *  falling back to the default sentinel. Never throws -- returns `{ error }`. */
export function gatherGitFabric(transport: GitFabricTransport, projectUri: string): Promise<GatherFabricResult> {
  if (projectUri === '*') return Promise.resolve({ error: 'cross-project: no single project' })
  let authority: string | undefined
  try {
    authority = parseProjectUri(projectUri).authority
  } catch {
    authority = undefined
  }
  const sentinel = (authority ? transport.getSentinelByAlias(authority) : undefined) ?? transport.getSentinel()
  if (!sentinel) return Promise.resolve({ error: 'sentinel offline' })

  const requestId = randomUUID()
  return new Promise<GatherFabricResult>(resolve => {
    const timeout = setTimeout(() => {
      transport.removeFileListener(requestId)
      resolve({ error: 'git fabric scan timed out (15s)' })
    }, GIT_FABRIC_TIMEOUT_MS)

    transport.addFileListener(requestId, msg => {
      clearTimeout(timeout)
      const result = msg as GitFabricResult
      if (!result.success) resolve({ error: result.error ?? 'git fabric scan failed' })
      else resolve({ fabric: result.fabric })
    })

    try {
      const req: GitFabricRequest = { type: 'git_fabric_request', requestId, projectUri }
      sentinel.send(JSON.stringify(req))
    } catch {
      clearTimeout(timeout)
      transport.removeFileListener(requestId)
      resolve({ error: 'sentinel send failed' })
    }
  })
}

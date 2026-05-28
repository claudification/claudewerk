/**
 * Real commit gathering for recaps. The recap module is broker-internal but
 * must NOT touch the host filesystem (boundary rule) -- it asks the sentinel
 * that owns each project to run `git log` via the `git_log_request` RPC.
 *
 * Injected into the recap orchestrator as `deps.gatherCommits` so the period
 * orchestrator stays decoupled (tests use the empty stub). Models the
 * list_dirs request/response idiom (routes/spawn.ts).
 */

import { randomUUID } from 'node:crypto'
import { parseProjectUri } from '../../shared/project-uri'
import type { GitLogRequest, GitLogResult } from '../../shared/protocol'
import type { CommitDigest, PeriodScope } from './period/gather/types'

const GIT_LOG_TIMEOUT_MS = 10_000

interface SentinelHandle {
  send: (data: string) => void
}

/** The slice of ConversationStore the gatherer needs. Keeping it minimal makes
 *  the gatherer unit-testable with a fake transport. */
export interface GitLogTransport {
  getSentinelByAlias: (alias: string) => SentinelHandle | undefined
  getSentinel: () => SentinelHandle | undefined
  addGitLogListener: (requestId: string, cb: (result: unknown) => void) => void
  removeGitLogListener: (requestId: string) => void
}

export function makeCommitGatherer(transport: GitLogTransport): (scope: PeriodScope) => Promise<CommitDigest> {
  return async (scope: PeriodScope): Promise<CommitDigest> => {
    const perProject = await Promise.all(
      scope.projectUris.map(uri => gatherOne(transport, uri, scope.periodStart, scope.periodEnd)),
    )
    return { perProject }
  }
}

// fallow-ignore-next-line complexity
async function gatherOne(
  transport: GitLogTransport,
  projectUri: string,
  sinceMs: number,
  untilMs: number,
): Promise<CommitDigest['perProject'][number]> {
  if (projectUri === '*') return { projectUri, cwd: '', commits: [], error: 'cross-project: no single cwd' }
  const parsed = parseProjectUri(projectUri)
  const cwd = parsed.path
  if (!cwd || cwd === '/') return { projectUri, cwd, commits: [], error: 'no project path' }

  const sentinel =
    (parsed.authority ? transport.getSentinelByAlias(parsed.authority) : undefined) ?? transport.getSentinel()
  if (!sentinel) return { projectUri, cwd, commits: [], error: 'sentinel offline' }

  const result = await requestGitLog(transport, sentinel, cwd, sinceMs, untilMs)
  if (!result.success) return { projectUri, cwd, commits: [], error: result.error }
  return {
    projectUri,
    cwd,
    commits: result.commits.map(c => ({
      sha: c.sha,
      isoDate: c.isoDate,
      author: c.author,
      subject: c.subject,
      body: c.body,
      filesChanged: c.filesChanged,
      insertions: c.insertions,
      deletions: c.deletions,
    })),
  }
}

function requestGitLog(
  transport: GitLogTransport,
  sentinel: SentinelHandle,
  cwd: string,
  sinceMs: number,
  untilMs: number,
): Promise<GitLogResult> {
  const requestId = randomUUID()
  return new Promise<GitLogResult>(resolve => {
    const timeout = setTimeout(() => {
      transport.removeGitLogListener(requestId)
      resolve({ type: 'git_log_result', requestId, cwd, success: false, commits: [], error: 'git log timed out (10s)' })
    }, GIT_LOG_TIMEOUT_MS)

    transport.addGitLogListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as GitLogResult)
    })

    try {
      const req: GitLogRequest = { type: 'git_log_request', requestId, cwd, sinceMs, untilMs }
      sentinel.send(JSON.stringify(req))
    } catch {
      clearTimeout(timeout)
      transport.removeGitLogListener(requestId)
      resolve({ type: 'git_log_result', requestId, cwd, success: false, commits: [], error: 'sentinel send failed' })
    }
  })
}

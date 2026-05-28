import { describe, expect, it } from 'bun:test'
import type { GitLogCommit, GitLogRequest } from '../../shared/protocol'
import { type GitLogTransport, makeCommitGatherer } from './commit-gather'
import type { PeriodScope } from './period/gather/types'

const scope = (uris: string[]): PeriodScope => ({
  projectUris: uris,
  periodStart: 1_000,
  periodEnd: 2_000,
  timeZone: 'UTC',
})

const sampleCommit: GitLogCommit = {
  sha: 'abc1234',
  isoDate: '2026-05-28T10:00:00+00:00',
  author: 'Jonas',
  subject: 'fix: thing',
  body: '',
  filesChanged: 2,
  insertions: 10,
  deletions: 1,
}

/** A transport whose sentinel echoes back a git_log_result synchronously when
 *  it "receives" a request -- exercising the full requestId round-trip. */
function fakeTransport(opts: { offline?: boolean; reply?: (cwd: string) => GitLogCommit[] } = {}): GitLogTransport {
  const pending = new Map<string, (result: unknown) => void>()
  const sentinel = {
    send(data: string) {
      const req = JSON.parse(data) as GitLogRequest
      const cb = pending.get(req.requestId)
      cb?.({
        type: 'git_log_result',
        requestId: req.requestId,
        cwd: req.cwd,
        success: true,
        commits: opts.reply ? opts.reply(req.cwd) : [sampleCommit],
      })
    },
  }
  return {
    getSentinelByAlias: () => (opts.offline ? undefined : sentinel),
    getSentinel: () => (opts.offline ? undefined : sentinel),
    addGitLogListener: (id, cb) => pending.set(id, cb),
    removeGitLogListener: id => pending.delete(id),
  }
}

describe('makeCommitGatherer', () => {
  it('gathers commits for a project URI via the RPC round-trip', async () => {
    const gather = makeCommitGatherer(fakeTransport())
    const digest = await gather(scope(['claude://default/Users/jonas/proj']))
    expect(digest.perProject.length).toBe(1)
    expect(digest.perProject[0].cwd).toBe('/Users/jonas/proj')
    expect(digest.perProject[0].commits.length).toBe(1)
    expect(digest.perProject[0].commits[0].sha).toBe('abc1234')
    expect(digest.perProject[0].commits[0].filesChanged).toBe(2)
    expect(digest.perProject[0].error).toBeUndefined()
  })

  it('reports sentinel offline without throwing', async () => {
    const gather = makeCommitGatherer(fakeTransport({ offline: true }))
    const digest = await gather(scope(['claude://default/Users/jonas/proj']))
    expect(digest.perProject[0].commits).toEqual([])
    expect(digest.perProject[0].error).toBe('sentinel offline')
  })

  it('skips the cross-project wildcard', async () => {
    const gather = makeCommitGatherer(fakeTransport())
    const digest = await gather(scope(['*']))
    expect(digest.perProject[0].commits).toEqual([])
    expect(digest.perProject[0].error).toContain('cross-project')
  })
})

import { describe, expect, it } from 'bun:test'
import type { GitFabric, GitFabricRequest } from '../../shared/protocol'
import { type GitFabricTransport, gatherGitFabric } from './git-fabric-gather'

const sampleFabric: GitFabric = {
  branches: [
    {
      branch: 'worktree-sotu',
      worktree: '/repo/.claude/worktrees/sotu',
      dirty: false,
      aheadOrigin: 2,
      behindOrigin: 1,
      aheadLocal: 2,
      behindLocal: 0,
      integration: 'merge-clean',
      alerts: [],
    },
  ],
  scannedAt: 1_000,
  fetchedAt: 900,
}

/** A transport whose sentinel echoes a git_fabric_result synchronously when it
 *  "receives" a request -- exercises the requestId round-trip over the generic
 *  file listener. */
function fakeTransport(opts: { offline?: boolean; fail?: string; throwOnSend?: boolean } = {}): GitFabricTransport {
  const pending = new Map<string, (result: unknown) => void>()
  const sentinel = {
    send(data: string) {
      if (opts.throwOnSend) throw new Error('boom')
      const req = JSON.parse(data) as GitFabricRequest
      const cb = pending.get(req.requestId)
      cb?.({
        type: 'git_fabric_result',
        requestId: req.requestId,
        projectUri: req.projectUri,
        success: !opts.fail,
        fabric: opts.fail ? undefined : sampleFabric,
        error: opts.fail,
      })
    },
  }
  return {
    getSentinelByAlias: () => (opts.offline ? undefined : sentinel),
    getSentinel: () => (opts.offline ? undefined : sentinel),
    addFileListener: (id, cb) => pending.set(id, cb),
    removeFileListener: id => pending.delete(id),
  }
}

describe('gatherGitFabric', () => {
  it('returns the fabric for a project URI via the RPC round-trip', async () => {
    const res = await gatherGitFabric(fakeTransport(), 'claude://default/Users/jonas/proj')
    expect(res.error).toBeUndefined()
    expect(res.fabric).toEqual(sampleFabric)
    expect(res.fabric?.branches[0].branch).toBe('worktree-sotu')
  })

  it('reports sentinel offline without throwing', async () => {
    const res = await gatherGitFabric(fakeTransport({ offline: true }), 'claude://default/Users/jonas/proj')
    expect(res.fabric).toBeUndefined()
    expect(res.error).toBe('sentinel offline')
  })

  it('surfaces a sentinel-side failure', async () => {
    const res = await gatherGitFabric(fakeTransport({ fail: 'not a git repository' }), 'claude://default/x')
    expect(res.fabric).toBeUndefined()
    expect(res.error).toBe('not a git repository')
  })

  it('skips the cross-project wildcard', async () => {
    const res = await gatherGitFabric(fakeTransport(), '*')
    expect(res.fabric).toBeUndefined()
    expect(res.error).toContain('cross-project')
  })

  it('handles a send throw without rejecting', async () => {
    const res = await gatherGitFabric(fakeTransport({ throwOnSend: true }), 'claude://default/x')
    expect(res.fabric).toBeUndefined()
    expect(res.error).toBe('sentinel send failed')
  })
})

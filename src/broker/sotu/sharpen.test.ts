/**
 * Liveness-sharpening tests: at-risk only for ABANDONED dirt, the new
 * `unmerged` alert for walked-away worktree branches, and pass-through for
 * the alerts liveness does not change (unpushed/stalled).
 */

import { expect, test } from 'bun:test'
import type { BranchFabric, GitFabric } from '../../shared/protocol'
import { sharpenAlerts } from './sharpen'

const WT = '/Users/test/proj/.claude/worktrees'

function branch(over: Partial<BranchFabric> = {}): BranchFabric {
  return {
    branch: 'feat-x',
    aheadOrigin: 2,
    behindOrigin: 1,
    aheadLocal: 2,
    behindLocal: 1,
    integration: 'merge-clean',
    alerts: [],
    ...over,
  }
}

function fabric(...branches: BranchFabric[]): GitFabric {
  return { branches, scannedAt: 1 }
}

const live = (...names: (string | null)[]) => new Set<string | null>(names)

test('no fabric -> no alerts', () => {
  expect(sharpenAlerts(undefined, live())).toEqual([])
})

test('at-risk suppressed while a live conversation sits in the dirty worktree', () => {
  const f = fabric(branch({ alerts: ['at-risk'], worktree: `${WT}/feat-x`, dirty: true }))
  expect(sharpenAlerts(f, live('feat-x'))).toEqual([])
})

test('at-risk kept when the dirty worktree has NO live conversation (abandoned dirt)', () => {
  const f = fabric(branch({ alerts: ['at-risk'], worktree: `${WT}/feat-x`, dirty: true }))
  expect(sharpenAlerts(f, live('other'))).toContain('at-risk')
})

test('at-risk from a branch with no worktree entry passes through (nothing to be live in)', () => {
  const f = fabric(branch({ alerts: ['at-risk'] }))
  expect(sharpenAlerts(f, live('feat-x'))).toContain('at-risk')
})

test('unmerged fires for an unintegrated worktree branch with no live conversation', () => {
  const f = fabric(branch({ worktree: `${WT}/feat-x`, integration: 'merge-clean' }))
  expect(sharpenAlerts(f, live())).toContain('unmerged')
})

test('unmerged suppressed while the worktree has a live conversation', () => {
  const f = fabric(branch({ worktree: `${WT}/feat-x`, integration: 'conflicts' }))
  expect(sharpenAlerts(f, live('feat-x'))).toEqual([])
})

test('unmerged never fires for an integrated branch', () => {
  const f = fabric(branch({ worktree: `${WT}/feat-x`, integration: 'integrated', aheadOrigin: 0 }))
  expect(sharpenAlerts(f, live())).toEqual([])
})

test('unmerged never fires for main/master (they ARE the integration target)', () => {
  const f = fabric(
    branch({ branch: 'main', worktree: '/Users/test/proj', integration: 'ff-clean' }),
    branch({ branch: 'master', worktree: '/Users/test/proj', integration: 'ff-clean' }),
  )
  expect(sharpenAlerts(f, live())).toEqual([])
})

test('unmerged never fires for a branch without a worktree (stalled covers rotting branches)', () => {
  const f = fabric(branch({ integration: 'merge-clean' }))
  expect(sharpenAlerts(f, live())).toEqual([])
})

test('unpushed and stalled pass through regardless of liveness', () => {
  const f = fabric(
    branch({ branch: 'main', worktree: '/Users/test/proj', alerts: ['unpushed'] }),
    branch({ branch: 'old', alerts: ['stalled'] }),
  )
  const out = sharpenAlerts(f, live(null, 'feat-x'))
  expect(out).toContain('unpushed')
  expect(out).toContain('stalled')
})

test('union dedupes across branches', () => {
  const f = fabric(
    branch({ branch: 'a', worktree: `${WT}/a`, integration: 'merge-clean' }),
    branch({ branch: 'b', worktree: `${WT}/b`, integration: 'conflicts' }),
  )
  expect(sharpenAlerts(f, live())).toEqual(['unmerged'])
})

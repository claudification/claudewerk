import { describe, expect, it } from 'bun:test'
import {
  deriveAlerts,
  deriveIntegration,
  parseMergeTreeConflicts,
  parseWorktreeList,
  runGitFabric,
  shortRef,
} from './git-fabric'

describe('shortRef', () => {
  it('strips refs/heads/ prefix', () => {
    expect(shortRef('refs/heads/worktree-sotu')).toBe('worktree-sotu')
  })
  it('leaves a non-heads ref verbatim', () => {
    expect(shortRef('refs/remotes/origin/main')).toBe('refs/remotes/origin/main')
  })
})

describe('parseWorktreeList', () => {
  it('parses the porcelain blocks into entries', () => {
    const out = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
        'worktree /repo/.claude/worktrees/sotu',
        'HEAD bbb222',
        'branch refs/heads/worktree-sotu',
        '',
        'worktree /repo/detached',
        'HEAD ccc333',
        'detached',
        '',
      ].join('\n'),
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ path: '/repo', head: 'aaa111', branch: 'main' })
    expect(out[1]).toEqual({ path: '/repo/.claude/worktrees/sotu', head: 'bbb222', branch: 'worktree-sotu' })
    expect(out[2]).toEqual({ path: '/repo/detached', head: 'ccc333', detached: true })
  })

  it('handles a trailing block with no final blank line', () => {
    const out = parseWorktreeList('worktree /repo\nHEAD aaa111\nbranch refs/heads/main')
    expect(out).toHaveLength(1)
    expect(out[0].branch).toBe('main')
  })

  it('returns [] for empty input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })
})

describe('parseMergeTreeConflicts', () => {
  it('returns the conflicting paths between line 1 and the first blank line', () => {
    // line1 = tree OID; then conflicting paths; then a blank line; then narration.
    const stdout = ['<tree-oid>', 'src/a.ts', 'src/b.ts', '', 'Auto-merging src/a.ts', 'CONFLICT (content): ...'].join(
      '\n',
    )
    expect(parseMergeTreeConflicts(stdout)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('ignores the narration when there are no conflicting paths', () => {
    // A clean merge: line1 = tree, immediately a blank line.
    expect(parseMergeTreeConflicts('<tree-oid>\n\nAuto-merging x')).toEqual([])
  })

  it('handles output with no trailing narration section', () => {
    expect(parseMergeTreeConflicts('<tree-oid>\nsrc/only.ts')).toEqual(['src/only.ts'])
  })
})

describe('deriveIntegration', () => {
  it('ahead==0 -> integrated (work absorbed)', () => {
    expect(deriveIntegration(0, 5, null)).toBe('integrated')
  })
  it('behind==0 -> ff-clean (trivial fast-forward)', () => {
    expect(deriveIntegration(3, 0, null)).toBe('ff-clean')
  })
  it('diverged + merge-tree rc 0 -> merge-clean', () => {
    expect(deriveIntegration(3, 4, 0)).toBe('merge-clean')
  })
  it('diverged + merge-tree rc !=0 -> conflicts', () => {
    expect(deriveIntegration(3, 4, 1)).toBe('conflicts')
  })
  it('integrated takes precedence even when also at behind 0', () => {
    expect(deriveIntegration(0, 0, null)).toBe('integrated')
  })
})

describe('deriveAlerts', () => {
  it('dirty worktree -> at-risk', () => {
    const a = deriveAlerts({ integration: 'merge-clean', dirty: true, isMain: false, aheadOrigin: 1, behindOrigin: 1 })
    expect(a).toContain('at-risk')
  })

  it('local main ahead of origin -> unpushed (only for main)', () => {
    const main = deriveAlerts({
      integration: 'ff-clean',
      dirty: false,
      isMain: true,
      aheadOrigin: 2,
      behindOrigin: 0,
    })
    expect(main).toContain('unpushed')
    const branch = deriveAlerts({
      integration: 'ff-clean',
      dirty: false,
      isMain: false,
      aheadOrigin: 2,
      behindOrigin: 0,
    })
    expect(branch).not.toContain('unpushed')
  })

  it('unmerged branch far behind origin -> stalled (rotting), not main', () => {
    const stalled = deriveAlerts({
      integration: 'merge-clean',
      dirty: false,
      isMain: false,
      aheadOrigin: 3,
      behindOrigin: 165,
    })
    expect(stalled).toContain('stalled')
    // An integrated branch never stalls (work landed -> decays, not rots).
    const integrated = deriveAlerts({
      integration: 'integrated',
      dirty: false,
      isMain: false,
      aheadOrigin: 0,
      behindOrigin: 165,
    })
    expect(integrated).not.toContain('stalled')
    // A barely-behind unmerged branch is not yet stalled.
    const fresh = deriveAlerts({
      integration: 'merge-clean',
      dirty: false,
      isMain: false,
      aheadOrigin: 3,
      behindOrigin: 5,
    })
    expect(fresh).not.toContain('stalled')
  })

  it('a clean integrated main yields no alerts', () => {
    expect(
      deriveAlerts({ integration: 'integrated', dirty: false, isMain: true, aheadOrigin: 0, behindOrigin: 0 }),
    ).toEqual([])
  })
})

// ─── LIVE smoke on THIS repo (multi-worktree + diverged state) ──────

describe('runGitFabric (live, this repo)', () => {
  // A REAL scan of whatever repo the developer is sitting in: cost scales with
  // branch + worktree count, and this one carries 70+. It is not slow because
  // anything is wrong, so it gets a budget that fits the work rather than
  // bun's 5s default (which failed it on any well-used checkout).
  //
  // MEASURED 2026-08-21, quiet box, this checkout (340 local branches -> the
  // MAX_BRANCHES=200 cap is saturated, 710 worktrees): 18.6s ALONE, 60.5s under
  // 10x-parallel full-suite load. Deliberately NOT raised past 60s: unlike the
  // scratch-repo tests next door, this one's runtime is a function of the
  // developer's disk, so any number is wrong again next week. The scan-scaling
  // fix is its own card -- git-fabric-live-scan-test-scales-with-the-box.
  const LIVE_SCAN_TIMEOUT_MS = 60_000

  it(
    'scans the current repo and returns a sensible fabric snapshot',
    () => {
      const out = runGitFabric(process.cwd(), 123_456)
      expect(out.error).toBeUndefined()
      expect(out.fabric).toBeDefined()
      const fabric = out.fabric!
      expect(fabric.scannedAt).toBe(123_456)
      // This repo has local branches; every entry is well-formed.
      expect(fabric.branches.length).toBeGreaterThan(0)
      for (const b of fabric.branches) {
        expect(typeof b.branch).toBe('string')
        expect(b.branch.length).toBeGreaterThan(0)
        expect(['integrated', 'ff-clean', 'merge-clean', 'conflicts']).toContain(b.integration)
        expect(b.aheadOrigin).toBeGreaterThanOrEqual(0)
        expect(b.behindOrigin).toBeGreaterThanOrEqual(0)
        expect(Array.isArray(b.alerts)).toBe(true)
        // conflictFiles only present on a conflicting branch.
        if (b.integration !== 'conflicts') expect(b.conflictFiles).toBeUndefined()
      }
    },
    LIVE_SCAN_TIMEOUT_MS,
  )

  it('returns an error for a non-git directory without throwing', () => {
    const out = runGitFabric('/nonexistent-sotu-git-fabric-probe', 1)
    // Not a git work tree -> structured error, never a throw.
    expect(out.error).toBeDefined()
    expect(out.fabric).toBeUndefined()
  })

  it('returns an error for an empty cwd', () => {
    expect(runGitFabric('', 1).error).toBe('no cwd')
  })
})

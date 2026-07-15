/**
 * Fleet enrichment tests (Phase 6) -- per-project SOTU folded into Sheaf, the
 * dead commits column finished from git-fabric, the cheap fleet union, and the
 * HARD per-project visibility filter (no chronicle bleed across projects).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BranchFabric, GitAlert, GitFabric } from '../../shared/protocol'
import type { SheafNode, SheafProject, SheafResponse } from '../../shared/sheaf-types'
import { writeChronicle } from './chronicle'
import { recordContribution } from './contribute'
import { enrichSheafWithSotu } from './fleet'
import { initSotuStore } from './index'
import { projectSlug } from './paths'
import { SOTU_TUNING_DEFAULTS } from './tuning'
import { type CalloutContrib, type Chronicle, emptyChronicle, type GitScanContrib } from './types'

const URI_A = 'claude://default/Users/test/alpha'
const URI_B = 'claude://default/Users/test/bravo'
const NOW = 2_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-fleet-'))
  initSotuStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function node(over: Partial<SheafNode> = {}): SheafNode {
  return {
    id: 'conv-x',
    title: 't',
    status: 'running',
    scope: URI_A,
    startedAt: 0,
    endedAt: null,
    durationMs: 0,
    tokens: { input: 0, output: 0, cache: 0 },
    cost: { amount: 0, estimated: false },
    model: null,
    worktreeName: null,
    commits: 0,
    outcomeLine: '',
    terminationReason: null,
    recap: null,
    recapFresh: false,
    description: null,
    summary: null,
    children: [],
    treeTotals: {
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
      durationWallMs: 0,
      convCount: 1,
    },
    ...over,
  }
}

function project(uri: string, forest: SheafNode[]): SheafProject {
  return {
    projectUri: uri,
    label: uri.split('/').pop() ?? uri,
    worktrees: [],
    forest,
    totals: {
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
      convCount: forest.length,
      treeCount: forest.length,
    },
  }
}

function sheaf(projects: SheafProject[]): SheafResponse {
  return {
    windowH: 24,
    windowStart: 0,
    windowEnd: NOW,
    generatedAt: NOW,
    totals: {
      projects: projects.length,
      conversations: 0,
      trees: 0,
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
    },
    projects,
  }
}

function branch(over: Partial<BranchFabric> = {}): BranchFabric {
  return {
    branch: 'feature-x',
    aheadOrigin: 0,
    behindOrigin: 0,
    aheadLocal: 0,
    behindLocal: 0,
    integration: 'merge-clean',
    alerts: [],
    ...over,
  }
}

function gitScanContrib(git: GitFabric, convId = ''): GitScanContrib {
  return { kind: 'git_scan', convId, ts: NOW - 1000, git }
}

function callout(over: Partial<CalloutContrib> = {}): CalloutContrib {
  return { kind: 'callout', convId: 'conv-a', ts: NOW - 500, type: 'lock', payload: 'x', weight: 'high', ...over }
}

const enabled = () => ({ enabled: true, budget: {}, params: SOTU_TUNING_DEFAULTS })
const allVisible = () => true

/** Seed a single-branch git scan carrying the given alerts for a project. */
function seedScan(uri: string, alerts: GitAlert[]): void {
  recordContribution(projectSlug(uri), gitScanContrib({ branches: [branch({ alerts })], scannedAt: NOW - 1000 }))
}
/** Seed a distilled chronicle (generatedAt set) with a narrative for a project. */
function seedNarrative(uri: string, narrative: string): void {
  writeChronicle(projectSlug(uri), { ...emptyChronicle(NOW - 3000), narrative })
}
/** Seed a file-claim callout from a conversation for a project. */
function seedClaim(uri: string, convId: string, path: string): void {
  recordContribution(projectSlug(uri), callout({ convId, target: { kind: 'claim', path } }))
}
/** Build a sheaf from the projects and run the Phase-6 enrichment over it. */
function run(
  projects: SheafProject[],
  canViewProject: (uri: string) => boolean = allVisible,
  resolveConfig = enabled,
): SheafResponse {
  const s = sheaf(projects)
  enrichSheafWithSotu(s, { canViewProject, resolveConfig, now: NOW })
  return s
}

test('attaches a per-project SOTU block (free floor: alerts + branches) for an enabled project', () => {
  const git: GitFabric = {
    branches: [branch({ alerts: ['at-risk', 'unpushed'] })],
    scannedAt: NOW - 1000,
    fetchedAt: NOW - 2000,
  }
  recordContribution(projectSlug(URI_A), gitScanContrib(git))
  const s = run([project(URI_A, [node()])])

  const sotu = s.projects[0].sotu!
  expect(sotu.enabled).toBe(true)
  expect(new Set(sotu.alerts)).toEqual(new Set(['at-risk', 'unpushed']))
  expect(sotu.branches).toHaveLength(1)
  expect(sotu.scannedAt).toBe(NOW - 1000)
  expect(sotu.fetchedAt).toBe(NOW - 2000)
})

test('finishes the dead commits column from git-fabric (per worktree)', () => {
  const git: GitFabric = {
    branches: [branch({ branch: 'feat', worktree: '/Users/test/alpha/.claude/worktrees/feature-x', aheadOrigin: 3 })],
    scannedAt: NOW - 1000,
  }
  recordContribution(projectSlug(URI_A), gitScanContrib(git))
  const wtNode = node({ id: 'conv-wt', worktreeName: 'feature-x' })
  const mainNode = node({ id: 'conv-main', worktreeName: null })
  const s = run([project(URI_A, [mainNode, wtNode])])

  expect(s.projects[0].forest.find(n => n.id === 'conv-wt')!.commits).toBe(3)
  expect(s.projects[0].forest.find(n => n.id === 'conv-main')!.commits).toBe(0)
})

test('fills commits on nested children too', () => {
  const git: GitFabric = {
    branches: [branch({ worktree: '/Users/test/alpha/.claude/worktrees/feature-x', aheadOrigin: 5 })],
    scannedAt: NOW - 1000,
  }
  recordContribution(projectSlug(URI_A), gitScanContrib(git))
  const child = node({ id: 'child', worktreeName: 'feature-x' })
  const root = node({ id: 'root', worktreeName: 'feature-x', children: [child] })
  const s = run([project(URI_A, [root])])
  expect(s.projects[0].forest[0].children[0].commits).toBe(5)
})

test('paid narrative only when enabled AND distilled; grounding attached', () => {
  const chronicle: Chronicle = {
    ...emptyChronicle(NOW - 3000),
    narrative: 'Alpha is mid-refactor.',
    now: [{ convId: 'conv-a', detail: 'refactor', ts: NOW - 3000 }],
  }
  writeChronicle(projectSlug(URI_A), chronicle)
  recordContribution(projectSlug(URI_A), callout({ convId: 'conv-a' }))
  const s = run([project(URI_A, [node()])])

  const sotu = s.projects[0].sotu!
  expect(sotu.narrative).toBe('Alpha is mid-refactor.')
  expect(sotu.generatedAt).toBe(NOW - 3000)
  expect(sotu.grounding).toBeDefined()
  expect(sotu.grounding!.precision).toBe(1) // conv-a cited and present
})

test('disabled project gets the floor but NO narrative even if a chronicle exists', () => {
  seedNarrative(URI_A, 'leftover')
  const s = run([project(URI_A, [node()])], allVisible, () => ({
    enabled: false,
    budget: {},
    params: SOTU_TUNING_DEFAULTS,
  }))
  const sotu = s.projects[0].sotu!
  expect(sotu.enabled).toBe(false)
  expect(sotu.narrative).toBeUndefined()
})

test('CONTENDED count reflects 2+ convs on one target', () => {
  seedClaim(URI_A, 'conv-a', 'src/x.ts')
  seedClaim(URI_A, 'conv-b', 'src/x.ts')
  const s = run([project(URI_A, [node()])])
  expect(s.projects[0].sotu!.contended).toBe(1)
})

test('VISIBILITY FILTER: a hidden project gets NO sotu block and is excluded from the union', () => {
  // Both projects have a chronicle; the viewer may see only A.
  seedNarrative(URI_A, 'alpha secret')
  seedNarrative(URI_B, 'bravo secret')
  seedScan(URI_B, ['stalled'])
  const s = run([project(URI_A, [node()]), project(URI_B, [node({ scope: URI_B })])], uri => uri === URI_A)

  expect(s.projects[0].sotu).toBeDefined()
  expect(s.projects[0].sotu!.narrative).toBe('alpha secret')
  // B is hidden -> no sotu block at all (no narrative, no alerts bleed).
  expect(s.projects[1].sotu).toBeUndefined()
  // The union reflects only A, and reports the 1 filtered project (never silent).
  expect(s.sotu!.filteredProjects).toBe(1)
  expect(s.sotu!.alerts).not.toContain('stalled') // B's alert must not bleed into the fleet union
  expect(s.sotu!.projectsWithNarrative).toBe(1)
})

test('liveness join: at-risk suppressed while a running conv sits in the dirty worktree, kept once it ends', () => {
  const wt = '/Users/test/alpha/.claude/worktrees/feat-x'
  const git: GitFabric = {
    branches: [branch({ branch: 'feat-x', alerts: ['at-risk'], worktree: wt, dirty: true })],
    scannedAt: NOW - 1000,
  }
  recordContribution(projectSlug(URI_A), gitScanContrib(git))

  // Running conv in that worktree -> dirt is just work happening, no alerts.
  const busy = run([project(URI_A, [node({ worktreeName: 'feat-x', status: 'running' })])])
  expect(busy.projects[0].sotu!.alerts).toEqual([])

  // Same scan, conv ended -> abandoned dirt (at-risk) + walked-away commits (unmerged).
  const gone = run([project(URI_A, [node({ worktreeName: 'feat-x', status: 'ended' })])])
  expect(new Set(gone.projects[0].sotu!.alerts)).toEqual(new Set(['at-risk', 'unmerged']))
  expect(gone.sotu!.unmergedProjects).toBe(1)
})

test('fleet union aggregates alerts, contention and per-class risk counts across visible projects', () => {
  seedScan(URI_A, ['at-risk'])
  seedClaim(URI_A, 'c1', 'a.ts')
  seedClaim(URI_A, 'c2', 'a.ts')
  seedScan(URI_B, ['at-risk', 'stalled'])
  const s = run([project(URI_A, [node()]), project(URI_B, [node({ scope: URI_B })])])

  const u = s.sotu!
  expect(new Set(u.alerts)).toEqual(new Set(['at-risk', 'stalled']))
  expect(u.atRiskProjects).toBe(2)
  expect(u.stalledProjects).toBe(1)
  expect(u.contended).toBe(1)
  expect(u.filteredProjects).toBe(0)
})

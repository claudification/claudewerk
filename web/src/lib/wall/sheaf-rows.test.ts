/**
 * The A6/A4 model layer. The rollup itself is tested at its home
 * (`src/shared/sheaf-summary.test.ts`); what is asserted here is the part this
 * file adds -- the look, the rail, the window label, and the two SOTU shapes.
 */

import type { SheafProject, SheafProjectSotu, SheafResponse, SheafSotuBlock } from '@shared/sheaf-types'
import { describe, expect, it } from 'vitest'
import type { ProjectLook } from '@/components/wall/use-project-look'
import {
  fleetPills,
  formatTokens,
  projectHasSomethingToSay,
  type SheafRowClaim,
  sheafView,
  sheafWindowLabel,
  sotuBlocks,
} from './sheaf-rows'

const look = (uri: string): ProjectLook => ({ projectName: uri.split('/').pop() ?? uri, projectColor: '#f0f' })

function project(label: string, cost: number, over: Partial<SheafProject> = {}): SheafProject {
  return {
    projectUri: `claude:///${label}`,
    label,
    worktrees: [],
    forest: [{ children: [] }, { children: [] }],
    totals: { tokens: { input: 2_100_000, output: 184_000, cache: 0 }, cost: { amount: cost, estimated: false } },
    ...over,
  } as unknown as SheafProject
}

function response(projects: SheafProject[], over: Partial<SheafResponse> = {}): SheafResponse {
  return {
    windowH: 24,
    windowStart: 0,
    windowEnd: 1,
    generatedAt: 1,
    totals: {
      projects: projects.length,
      conversations: 9,
      trees: 4,
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 41.2, estimated: false },
    },
    projects,
    ...over,
  }
}

describe('sheafWindowLabel', () => {
  it('keeps hours below two days and spells a week as days', () => {
    expect(sheafWindowLabel(6)).toBe('6h')
    expect(sheafWindowLabel(24)).toBe('24h')
    expect(sheafWindowLabel(168)).toBe('7d')
  })
})

describe('formatTokens', () => {
  it('uses the mockup widths', () => {
    expect(formatTokens(2_100_000)).toBe('2.1M')
    expect(formatTokens(184_000)).toBe('184k')
    expect(formatTokens(812)).toBe('812')
  })
})

describe('sheafView', () => {
  it('resolves the look per project and keeps the summariser numbers', () => {
    const view = sheafView(response([project('rclaude', 28.4)]), look)
    expect(view.windowH).toBe(24)
    expect(view.totals.costUsd).toBe(41.2)
    expect(view.rows[0]).toMatchObject({
      projectName: 'rclaude',
      projectColor: '#f0f',
      costUsd: 28.4,
      trees: 2,
      inputTokens: 2_100_000,
    })
  })

  it('scales the rail against the biggest row, not against the total', () => {
    const view = sheafView(response([project('big', 100), project('small', 25)]), look)
    expect(view.rows[0]?.costShare).toBe(1)
    expect(view.rows[1]?.costShare).toBe(0.25)
  })

  it('reports clipped projects instead of dropping them silently', () => {
    const many = Array.from({ length: 22 }, (_, i) => project(`p${i}`, 22 - i))
    expect(sheafView(response(many), look).clipped).toBe(2)
    expect(sheafView(response([project('one', 1)]), look).clipped).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// "only active, or projects with information in them" (Jonas, 2026-08-20)
// ---------------------------------------------------------------------------

const claim = (over: Partial<SheafRowClaim> = {}): SheafRowClaim => ({
  live: false,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  alerts: [],
  unmergedCommits: 0,
  ...over,
})

describe('projectHasSomethingToSay', () => {
  it('sends home a project with nothing on any of the four clauses', () => {
    expect(projectHasSomethingToSay(claim())).toBe(false)
  })

  it.each([
    ['a live conversation', { live: true }],
    ['money spent in the window', { costUsd: 0.02 }],
    ['tokens in', { inputTokens: 1 }],
    ['tokens out', { outputTokens: 1 }],
    ['a git alert', { alerts: ['at-risk'] }],
    ['an unmerged commit', { unmergedCommits: 1 }],
  ])('keeps a project on %s alone', (_why, over) => {
    expect(projectHasSomethingToSay(claim(over))).toBe(true)
  })

  it('keeps a DORMANT project that is sitting on unpushed work', () => {
    // The reason this is not `costUsd > 0`: quiet AND the most important row.
    expect(projectHasSomethingToSay(claim({ unmergedCommits: 11 }))).toBe(true)
  })
})

/** A project the window has nothing to say about: no spend, no tokens, no forest. */
const empty = (label: string, over: Partial<SheafProject> = {}): SheafProject =>
  project(label, 0, {
    forest: [],
    totals: {
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
      convCount: 0,
      treeCount: 0,
    },
    ...over,
  })

/** The free SOTU floor -- what a chronicle-off project still carries. */
const floor = (over: Partial<SheafProjectSotu> = {}): SheafProjectSotu => ({
  enabled: false,
  alerts: [],
  contended: 0,
  branches: [],
  ...over,
})

const live = (label: string): SheafProject =>
  empty(label, {
    forest: [{ status: 'running', children: [] }],
  } as unknown as Partial<SheafProject>)

describe('sheafView scope', () => {
  it('renders the three projects with something to say and counts the one without', () => {
    const view = sheafView(
      response([
        live('running-now'),
        empty('alert-only', { sotu: floor({ alerts: ['at-risk'] }) }),
        empty('unmerged-only', {
          sotu: floor({ branches: [{ aheadOrigin: 11 }] as unknown as SheafProjectSotu['branches'] }),
        }),
        empty('nothing-at-all'),
      ]),
      look,
    )
    expect(view.rows.map(r => r.projectName)).toEqual(['running-now', 'alert-only', 'unmerged-only'])
    expect(view.quiet).toBe(1)
  })

  it('says nothing about quiet projects when every project earned its row', () => {
    expect(sheafView(response([project('busy', 3)]), look).quiet).toBe(0)
  })

  it('keeps `clipped` and `quiet` apart -- too expensive to fit is not the same as dull', () => {
    const many = Array.from({ length: 22 }, (_, i) => project(`p${i}`, 22 - i))
    const view = sheafView(response([...many, empty('dull')]), look)
    // `dull` sorts last on the server, so it is INSIDE the clip already; what
    // reaches the predicate is the top 20, all of which have spend.
    expect(view.clipped).toBe(3)
    expect(view.quiet).toBe(0)
  })

  it('scales the rail against the biggest SURVIVING row', () => {
    const view = sheafView(response([project('big', 100), empty('gone'), project('small', 25)]), look)
    expect(view.rows.map(r => r.costShare)).toEqual([1, 0.25])
  })

  it('recomputes membership per window -- a project quiet at 6h can be loud at 7d', () => {
    const at6h = sheafView(response([project('busy', 4), empty('slow')], { windowH: 6 }), look)
    expect(at6h.rows.map(r => r.projectName)).toEqual(['busy'])
    expect(at6h.quiet).toBe(1)

    // Same fleet, wider window: the slow project's spend is now inside it.
    const at7d = sheafView(response([project('busy', 9), project('slow', 2)], { windowH: 168 }), look)
    expect(at7d.rows.map(r => r.projectName)).toEqual(['busy', 'slow'])
    expect(at7d.quiet).toBe(0)
  })
})

const union = (over: Partial<NonNullable<SheafResponse['sotu']>> = {}): SheafResponse['sotu'] => ({
  projectsEnabled: 0,
  projectsWithNarrative: 0,
  alerts: [],
  contended: 0,
  atRiskProjects: 0,
  unpushedProjects: 0,
  stalledProjects: 0,
  unmergedProjects: 0,
  filteredProjects: 0,
  blocks: [],
  ...over,
})

/** A roster row, typed against the wire contract -- these tests exist to pin
 *  `SheafSotuBlock`'s shape, so opting out of checking it would defeat them. */
const row = (label: string, over: Partial<SheafSotuBlock> = {}): SheafSotuBlock => ({
  projectUri: `claude:///${label}`,
  alerts: [],
  contended: 0,
  unmerged: 0,
  ...over,
})

describe('sotuBlocks', () => {
  it('reads the SERVER roster, not the project list', () => {
    // The project is on the response (A6 renders it) but not on the roster -- so
    // the scope gate is the broker's, and this function does not second-guess it.
    const blocks = sotuBlocks(response([project('off', 1)], { sotu: union() }), look)
    expect(blocks).toEqual([])
  })

  it('renders nothing when the response carried no fleet union at all', () => {
    expect(sotuBlocks(response([project('p', 1)]), look)).toEqual([])
  })

  it('puts the projects that HAVE a chronicle first', () => {
    const sotu = union({ blocks: [row('quiet'), row('loud', { narrative: 'main is RED' })] })
    expect(sotuBlocks(response([], { sotu }), look).map(b => b.projectName)).toEqual(['loud', 'quiet'])
  })

  it('carries the alerts, the contention and the unmerged count through', () => {
    const sotu = union({
      blocks: [row('p', { narrative: 'x', alerts: ['at-risk'], contended: 2, unmerged: 7 })],
    })
    expect(sotuBlocks(response([], { sotu }), look)[0]).toMatchObject({
      unmerged: 7,
      contended: 2,
      alerts: ['at-risk'],
    })
  })

  it('leaves the narrative absent for a chronicle-on project that never distilled', () => {
    const sotu = union({ blocks: [row('never')] })
    expect(sotuBlocks(response([], { sotu }), look)[0].narrative).toBeUndefined()
  })
})

describe('fleetPills', () => {
  it('maps each alert class to its own pill and drops the zeroes', () => {
    const pills = fleetPills({
      projectsEnabled: 2,
      projectsWithNarrative: 1,
      alerts: ['at-risk'],
      contended: 0,
      atRiskProjects: 1,
      unpushedProjects: 0,
      stalledProjects: 3,
      unmergedProjects: 0,
      filteredProjects: 2,
      blocks: [],
    })
    expect(pills.map(p => [p.key, p.label, p.tone])).toEqual([
      ['at-risk', '1 at-risk', 'bad'],
      ['stalled', '3 stalled', 'warn'],
      ['hidden', '2 not shown', 'plain'],
    ])
  })

  it('flags an ungrounded chronicle as bad, a grounded one as plain', () => {
    const base = {
      projectsEnabled: 1,
      projectsWithNarrative: 1,
      alerts: [],
      contended: 0,
      atRiskProjects: 0,
      unpushedProjects: 0,
      stalledProjects: 0,
      unmergedProjects: 0,
      filteredProjects: 0,
      blocks: [],
    }
    const lying = fleetPills({ ...base, grounding: { precision: 0.5, coverage: 1, citedConvs: 4, unknownCited: 2 } })
    expect(lying[0]).toMatchObject({ key: 'grounding', label: 'grounded 50%', tone: 'bad' })
    const clean = fleetPills({ ...base, grounding: { precision: 1, coverage: 1, citedConvs: 4, unknownCited: 0 } })
    expect(clean[0]).toMatchObject({ label: 'grounded 100%', tone: 'plain' })
  })

  it('renders nothing when the response carried no fleet union', () => {
    expect(fleetPills(undefined)).toEqual([])
  })
})

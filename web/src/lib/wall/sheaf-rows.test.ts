/**
 * The A6/A4 model layer. The rollup itself is tested at its home
 * (`src/shared/sheaf-summary.test.ts`); what is asserted here is the part this
 * file adds -- the look, the rail, the window label, and the two SOTU shapes.
 */

import type { SheafProject, SheafResponse } from '@shared/sheaf-types'
import { describe, expect, it } from 'vitest'
import type { ProjectLook } from '@/components/wall/use-project-look'
import { fleetPills, formatTokens, sheafView, sheafWindowLabel, sotuBlocks } from './sheaf-rows'

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

const sotu = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  alerts: [],
  contended: 0,
  branches: [],
  ...over,
})

describe('sotuBlocks', () => {
  it('skips a project the viewer cannot see (no sotu block at all)', () => {
    const blocks = sotuBlocks(response([project('hidden', 1)]), look)
    expect(blocks).toEqual([])
  })

  it('puts the projects that HAVE a chronicle first', () => {
    const quiet = project('quiet', 5, { sotu: sotu() as never })
    const loud = project('loud', 1, { sotu: sotu({ narrative: 'main is RED' }) as never })
    expect(sotuBlocks(response([quiet, loud]), look).map(b => b.projectName)).toEqual(['loud', 'quiet'])
  })

  it('says WHY a project is quiet rather than rendering silence', () => {
    const off = project('off', 1, { sotu: sotu({ enabled: false }) as never })
    const never = project('never', 1, { sotu: sotu({ enabled: true }) as never })
    const blocks = sotuBlocks(response([off, never]), look)
    expect(blocks.map(b => b.quiet)).toEqual(['not-enabled', 'not-distilled'])
  })

  it('sums ahead-of-origin commits across the branches', () => {
    const p = project('p', 1, {
      sotu: sotu({
        narrative: 'x',
        alerts: ['at-risk'],
        contended: 2,
        branches: [{ aheadOrigin: 3 }, { aheadOrigin: 4 }],
      }) as never,
    })
    expect(sotuBlocks(response([p]), look)[0]).toMatchObject({ unmerged: 7, contended: 2, alerts: ['at-risk'] })
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

import { describe, expect, test } from 'bun:test'
import type { SheafNode, SheafProject, SheafResponse } from '../../shared/sheaf-types'
import { summarizeSheaf } from './fleet-sheaf'

function node(children: SheafNode[] = []): SheafNode {
  return {
    conversationId: `c_${Math.random().toString(36).slice(2, 8)}`,
    title: 't',
    scope: 'claude:///p',
    status: 'ended',
    startedAt: 0,
    durationMs: 0,
    tokens: { input: 0, output: 0, cache: 0 },
    cost: { amount: 0, estimated: false },
    commits: 0,
    children,
  } as unknown as SheafNode
}

function project(label: string, cost: number, forest: SheafNode[]): SheafProject {
  return {
    projectUri: `claude:///${label}`,
    label,
    worktrees: [],
    forest,
    totals: {
      tokens: { input: 1000, output: 200, cache: 0 },
      cost: { amount: cost, estimated: false },
    },
  } as unknown as SheafProject
}

function sheaf(projects: SheafProject[]): SheafResponse {
  return {
    windowH: 24,
    windowStart: 0,
    windowEnd: 1,
    generatedAt: 1,
    totals: {
      projects: projects.length,
      conversations: 5,
      trees: 3,
      tokens: { input: 1000, output: 200, cache: 0 },
      cost: { amount: 12.345, estimated: false },
    },
    projects,
  }
}

describe('summarizeSheaf', () => {
  test('compacts totals + per-project rollups, counting nested conversations', () => {
    const s = summarizeSheaf(sheaf([project('rclaude', 10.5, [node([node(), node()])])]))
    expect(s.totals.costUsd).toBe(12.35)
    expect(s.projects).toHaveLength(1)
    expect(s.projects[0]).toMatchObject({ project: 'rclaude', costUsd: 10.5, conversations: 3, trees: 1 })
    expect(s.clipped).toBeUndefined()
  })

  test('clips beyond maxProjects and says so', () => {
    const many = Array.from({ length: 5 }, (_, i) => project(`p${i}`, 5 - i, [node()]))
    const s = summarizeSheaf(sheaf(many), 2)
    expect(s.projects).toHaveLength(2)
    expect(s.projects[0]?.project).toBe('p0')
    expect(s.clipped).toBe(3)
  })

  test('surfaces sotu alerts + unmerged commits when the response is enriched', () => {
    const p = project('rclaude', 1, [node()])
    ;(p as { sotu?: unknown }).sotu = {
      enabled: true,
      alerts: ['at-risk'],
      contended: 0,
      branches: [{ aheadOrigin: 2 }, { aheadOrigin: 1 }],
    }
    const s = summarizeSheaf(sheaf([p]))
    expect(s.projects[0]?.alerts).toEqual(['at-risk'])
    expect(s.projects[0]?.unmergedCommits).toBe(3)
  })
})

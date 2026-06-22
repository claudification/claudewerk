import { describe, expect, test } from 'bun:test'
import { composeProjectsOverview, type OverviewConv, type ProjectLike } from './overview'

const P = (key: string, label: string): ProjectLike => ({ key, label, projectUri: `claude://d/${label}` })
const conv = (projectKey: string, over: Partial<OverviewConv> = {}): OverviewConv => ({
  projectKey,
  ended: false,
  ...over,
})

describe('composeProjectsOverview', () => {
  const projects = [P('ka', 'arr'), P('kb', 'remote'), P('kc', 'idle-proj')]
  const briefs = new Map([
    ['ka', 'arr is a media indexer'],
    ['kb', 'remote is the broker'],
  ])

  test('includes projects with zero live conversations (the arr-with-nothing case)', () => {
    const rows = composeProjectsOverview(projects, briefs, [], 1000)
    expect(rows.map(r => r.project).sort()).toEqual(['arr', 'idle-proj', 'remote'])
    const idle = rows.find(r => r.project === 'idle-proj')
    expect(idle?.live).toBe(0)
    expect(idle?.brief).toBe('')
  })

  test('counts live / working / needs-you per project, ignoring ended', () => {
    const convs = [
      conv('ka', { liveState: 'working' }),
      conv('ka', { liveState: 'needs_you' }),
      conv('ka', { ended: true }),
      conv('kb', { liveState: 'blocked' }),
    ]
    const rows = composeProjectsOverview(projects, briefs, convs, 1000)
    const arr = rows.find(r => r.project === 'arr')
    expect(arr).toMatchObject({ live: 2, working: 1, needsYou: 1 })
    const remote = rows.find(r => r.project === 'remote')
    expect(remote).toMatchObject({ live: 1, needsYou: 1 }) // blocked counts as needs-you
  })

  test('orders attention-first, then by liveness, then recency', () => {
    const now = 1_000_000
    const convs = [
      conv('kb', { liveState: 'needs_you' }),
      conv('ka', { liveState: 'working', lastActivity: now - 60000 }),
    ]
    const rows = composeProjectsOverview(projects, briefs, convs, now)
    expect(rows[0].project).toBe('remote') // needs-you wins
    expect(rows[1].project).toBe('arr')
  })

  test('derives idleMin from the most recent activity', () => {
    const now = 1_000_000
    const rows = composeProjectsOverview([P('ka', 'arr')], briefs, [conv('ka', { lastActivity: now - 120000 })], now)
    expect(rows[0].idleMin).toBe(2)
  })

  test('conversations with no project key are skipped', () => {
    const rows = composeProjectsOverview([P('ka', 'arr')], briefs, [{ projectKey: null, ended: false }], 1000)
    expect(rows[0].live).toBe(0)
  })
})

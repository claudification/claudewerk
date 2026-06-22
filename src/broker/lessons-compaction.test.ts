import { describe, expect, it } from 'bun:test'
import type { RecapMetadata } from '../shared/protocol'
import {
  buildTechRegistry,
  type CompactionDeps,
  compactOnce,
  type LessonsRecapRecord,
  mergeLessonsMetadata,
  msUntilNextWeekday,
  queryTech,
} from './lessons-compaction'
import { makeEmptyMetadata } from './recap/period/chunk/merge'

function meta(over: Partial<RecapMetadata>): RecapMetadata {
  return { ...makeEmptyMetadata(), ...over }
}

describe('mergeLessonsMetadata', () => {
  it('folds base + optional item fields (tech_discovered, recommendations) deduped', () => {
    const merged = mergeLessonsMetadata([
      meta({
        decisions: [{ title: 'use bun:sqlite', conversations: ['conv_a'] }],
        tech_discovered: [{ title: 'bun:sqlite', outcome: 'success', conversations: ['conv_a'] }],
      }),
      meta({
        decisions: [{ title: 'Use bun:sqlite', conversations: ['conv_b'] }],
        tech_discovered: [{ title: 'bun:sqlite', outcome: 'failure', conversations: ['conv_b'] }],
        recommendations: [{ title: 'document the WAL gotcha' }],
      }),
    ])
    expect(merged.decisions).toHaveLength(1)
    expect(merged.decisions[0].conversations).toEqual(['conv_a', 'conv_b'])
    expect(merged.tech_discovered).toHaveLength(1)
    // conflicting outcomes reconcile to mixed
    expect(merged.tech_discovered?.[0].outcome).toBe('mixed')
    expect(merged.recommendations).toHaveLength(1)
  })

  it('leaves optional fields absent when nothing to merge', () => {
    const merged = mergeLessonsMetadata([meta({ decisions: [{ title: 'x' }] })])
    expect(merged.tech_discovered).toBeUndefined()
    expect(merged.recommendations).toBeUndefined()
  })
})

function rec(id: string, metadata: Partial<RecapMetadata>, completedAt = 1): LessonsRecapRecord {
  return { id, completedAt, metadata: meta(metadata) }
}

function makeCompactionDeps(over: Partial<CompactionDeps> = {}): {
  deps: CompactionDeps
  saved: Array<[string, RecapMetadata]>
  reaped: string[]
} {
  const saved: Array<[string, RecapMetadata]> = []
  const reaped: string[] = []
  const deps: CompactionDeps = {
    now: () => 1000,
    log: () => {},
    listProjectUris: () => ['p/a', 'p/b'],
    isEnabled: () => true,
    loadNightlies: uri =>
      uri === 'p/a'
        ? [
            rec('r1', { tech_discovered: [{ title: 'redis', outcome: 'success' }] }),
            rec('r2', { decisions: [{ title: 'd' }] }),
          ]
        : [],
    loadLedger: () => null,
    saveLedger: (uri, m) => saved.push([uri, m]),
    reap: ids => reaped.push(...ids),
    ...over,
  }
  return { deps, saved, reaped }
}

describe('compactOnce', () => {
  it('folds nightlies into a ledger and reaps them; skips projects with none', async () => {
    const { deps, saved, reaped } = makeCompactionDeps()
    const res = await compactOnce(deps)
    expect(res).toEqual({ projects: 2, compacted: 1, reaped: 2, skipped: 1 })
    expect(saved).toHaveLength(1)
    expect(saved[0][0]).toBe('p/a')
    expect(reaped).toEqual(['r1', 'r2'])
  })

  it('merges the existing ledger into the fold (accumulating durable memory)', async () => {
    const { deps, saved } = makeCompactionDeps({
      listProjectUris: () => ['p/a'],
      loadLedger: () => rec('ledger', { decisions: [{ title: 'old decision', conversations: ['conv_old'] }] }),
      loadNightlies: () => [rec('r1', { decisions: [{ title: 'new decision', conversations: ['conv_new'] }] })],
    })
    await compactOnce(deps)
    const [, merged] = saved[0]
    const titles = merged.decisions.map(d => d.title)
    expect(titles).toContain('old decision')
    expect(titles).toContain('new decision')
  })

  it('does not reap when a project is opted out', async () => {
    const { deps, reaped } = makeCompactionDeps({ isEnabled: () => false })
    const res = await compactOnce(deps)
    expect(res.compacted).toBe(0)
    expect(reaped).toEqual([])
  })
})

describe('buildTechRegistry + queryTech', () => {
  const ledgers = [
    {
      projectUri: 'claude://default/web',
      metadata: meta({
        tech_discovered: [
          { title: 'Redis', outcome: 'success', conversations: ['conv_w1'] },
          { title: 'react-virtuoso', outcome: 'failure' },
        ],
      }),
    },
    {
      projectUri: 'claude://default/api',
      metadata: meta({ tech_discovered: [{ title: 'redis', outcome: 'mixed', conversations: ['conv_a1'] }] }),
    },
  ]

  it('aggregates a tech across projects, most-used first', () => {
    const registry = buildTechRegistry(ledgers)
    expect(registry[0].tech.toLowerCase()).toBe('redis')
    expect(registry[0].usages).toHaveLength(2)
    expect(registry[0].usages.map(u => u.project).sort()).toEqual(['api', 'web'])
    expect(registry[0].usages.find(u => u.project === 'web')?.outcome).toBe('success')
  })

  it('queryTech filters by normalized substring', () => {
    const registry = buildTechRegistry(ledgers)
    expect(queryTech(registry, 'redis').map(e => e.tech.toLowerCase())).toEqual(['redis'])
    expect(queryTech(registry, 'virtuoso')).toHaveLength(1)
    expect(queryTech(registry, '')).toHaveLength(2)
  })
})

describe('msUntilNextWeekday', () => {
  it('targets the next occurrence of the weekday + hour', () => {
    // 2026-06-22 is a Monday (getDay()===1). Target Sunday(0) 05:00.
    const mon = new Date(2026, 5, 22, 10, 0, 0, 0).getTime()
    const ms = msUntilNextWeekday(0, 5, mon)
    const target = new Date(2026, 5, 28, 5, 0, 0, 0).getTime() // next Sunday 05:00
    expect(ms).toBe(target - mon)
  })

  it('rolls a full week when today is the weekday but the hour passed', () => {
    const sun = new Date(2026, 5, 28, 6, 0, 0, 0).getTime() // Sunday 06:00, target 05:00
    const ms = msUntilNextWeekday(0, 5, sun)
    expect(ms).toBe(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000) // 6d23h
  })

  it('is always strictly positive', () => {
    const sun = new Date(2026, 5, 28, 5, 0, 0, 0).getTime() // exactly Sunday 05:00
    expect(msUntilNextWeekday(0, 5, sun)).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

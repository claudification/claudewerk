/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { matchesPulseQuery, type PulseSearchable, parsePulseQuery } from '@/lib/pulse/filter'
// Through the barrel on purpose: this is the surface eleven panes will import.
import {
  constrainsNothing,
  matchesWallRow,
  parseWallQuery,
  restrictToAxes,
  WALL_AXES,
  type WallAxis,
  type WallQuery,
  type WallRowFacets,
} from './filter'

/** A FULL pulse row, so the same value can go through both matchers. */
const row = (over: Partial<PulseSearchable> = {}): PulseSearchable => ({
  title: 'epic-run ceiling copy',
  project: 'remote-claude',
  action: 'permission: rm -rf',
  tag: 'worktree-epic-run',
  ageMs: 60_000,
  band: 'needs',
  ...over,
})

describe('one grammar, one parser, one matcher', () => {
  it('re-exports pulse rather than forking it', () => {
    // Identity, not equivalence: if these ever stop being the same function
    // object there are two grammars in the tree and the wall has forked.
    expect(parseWallQuery).toBe(parsePulseQuery)
  })

  it('matches through the same matcher pulse uses', () => {
    const q = parseWallQuery('@remote-claude')
    const facets = row()
    expect(matchesWallRow(facets, q)).toBe(matchesPulseQuery(facets, q))
  })
})

describe('restrictToAxes', () => {
  it('keeps a declared axis', () => {
    const scoped: WallQuery = restrictToAxes(parseWallQuery('%70'), ['context'])
    expect(scoped.minContextPct).toBe(70)
  })

  it('clears every undeclared axis', () => {
    const q: WallQuery = parseWallQuery('epic @rc #wip ~30m $1 %70 &studio :opus ! +over')
    const scoped = restrictToAxes(q, [])
    expect(scoped.text).toBe('')
    expect(scoped.bands).toBeNull()
    expect(scoped.project).toBeNull()
    expect(scoped.tag).toBeNull()
    expect(scoped.windowMs).toBeNull()
    expect(scoped.minCostUsd).toBeNull()
    expect(scoped.minContextPct).toBeNull()
    expect(scoped.host).toBeNull()
    expect(scoped.model).toBeNull()
    expect(scoped.onlyManaged).toBe(false)
  })

  it('clears the exclusion bucket with its axis', () => {
    const q = parseWallQuery('-@anvil -#wip -&studio -:opus -noise')
    expect(restrictToAxes(q, []).not).toEqual({ text: [], projects: [], tags: [], hosts: [], models: [], bands: [] })
    expect(restrictToAxes(q, ['project']).not.projects).toEqual(['anvil'])
    expect(restrictToAxes(q, ['project']).not.tags).toEqual([])
  })

  it('never mutates the shared query', () => {
    const q = parseWallQuery('@rc -#wip')
    restrictToAxes(q, [])
    expect(q.project).toBe('rc')
    expect(q.not.tags).toEqual(['wip'])
  })

  it('neutralises `managed` to include-everything when undeclared', () => {
    // The grammar HIDES managed rows by default. A pane that never declared it
    // understands provenance must not silently lose those rows.
    expect(restrictToAxes(parseWallQuery(''), []).includeManaged).toBe(true)
    expect(restrictToAxes(parseWallQuery('+only'), []).onlyManaged).toBe(false)
  })

  it('leaves the hide-by-default rule alone when `managed` IS declared', () => {
    expect(restrictToAxes(parseWallQuery(''), ['managed']).includeManaged).toBe(false)
    expect(restrictToAxes(parseWallQuery('+over'), ['managed']).includeManaged).toBe(true)
  })

  it('passes the whole grammar through when every axis is declared', () => {
    const q = parseWallQuery('epic @rc #wip ~30m $1 %70 &studio :opus')
    expect(restrictToAxes(q, WALL_AXES)).toEqual(q)
  })
})

describe('undeclared axes cannot empty a pane', () => {
  // The card's headline case: `%70` on a commit-river-shaped pane.
  const commits: WallRowFacets[] = [
    { title: 'fix(theme): one ::selection rule', project: 'remote-claude', tag: 'main' },
    { title: 'feat(sidebar): project colour', project: 'remote-claude', tag: 'main' },
  ]

  const keep = (raw: string, axes: readonly WallAxis[]) => {
    const scoped = restrictToAxes(parseWallQuery(raw), axes)
    return commits.filter(c => matchesWallRow(c, scoped)).length
  }

  it('leaves a context filter unapplied on a pane without the context axis', () => {
    expect(keep('%70', ['text', 'project'])).toBe(commits.length)
  })

  it('applies it when the pane DOES declare the axis', () => {
    expect(keep('%70', ['context'])).toBe(0)
  })

  it('still applies the axes the pane declared', () => {
    expect(keep('%70 sidebar', ['text'])).toBe(1)
  })

  it('drops nothing for a cost, time, band, host or model filter it cannot read', () => {
    for (const raw of ['$5', '~1m', '!', '&studio', ':opus', '+only']) {
      expect(keep(raw, ['text', 'project'])).toBe(commits.length)
    }
  })
})

describe('constrainsNothing', () => {
  it('is true for an empty query on a pane that ignores provenance', () => {
    expect(constrainsNothing(restrictToAxes(parseWallQuery(''), ['text']))).toBe(true)
  })

  it('is true when every typed axis was stripped', () => {
    expect(constrainsNothing(restrictToAxes(parseWallQuery('%70 $5'), ['text']))).toBe(true)
  })

  it('is false while the hide-managed default is live', () => {
    expect(constrainsNothing(restrictToAxes(parseWallQuery(''), ['managed']))).toBe(false)
  })

  it('is false for `+only` and for any surviving constraint', () => {
    expect(constrainsNothing(restrictToAxes(parseWallQuery('+over +only'), ['managed']))).toBe(false)
    expect(constrainsNothing(restrictToAxes(parseWallQuery('epic'), ['text']))).toBe(false)
    expect(constrainsNothing(restrictToAxes(parseWallQuery('-noise'), ['text']))).toBe(false)
  })
})

describe('partial rows', () => {
  it('never drops a row for a facet it does not carry', () => {
    const bare: WallRowFacets = { title: 'a commit' }
    for (const raw of ['~1s', '$0', '%0']) {
      expect(matchesWallRow(bare, restrictToAxes(parseWallQuery(raw), WALL_AXES))).toBe(true)
    }
  })

  it('still searches the facets it does carry', () => {
    const bare: WallRowFacets = { title: 'a commit' }
    expect(matchesWallRow(bare, restrictToAxes(parseWallQuery('commit'), WALL_AXES))).toBe(true)
    expect(matchesWallRow(bare, restrictToAxes(parseWallQuery('missing'), WALL_AXES))).toBe(false)
  })
})

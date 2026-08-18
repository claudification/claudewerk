import { describe, expect, it } from 'vitest'
import type { PulseBand } from './bands'
import {
  highlightRange,
  isEmptyQuery,
  matchesPulseQuery,
  type PulseSearchable,
  parsePulseQuery,
  parseWindow,
} from './filter'

const row = (over: Partial<PulseSearchable> = {}): PulseSearchable => ({
  title: 'epic-run ceiling copy',
  project: 'remote-claude',
  action: 'permission: rm -rf',
  tag: 'worktree-epic-run',
  ageMs: 60_000,
  band: 'needs',
  ...over,
})

describe('parseWindow', () => {
  it('parses every unit', () => {
    expect(parseWindow('~90s')).toBe(90_000)
    expect(parseWindow('~30m')).toBe(1_800_000)
    expect(parseWindow('~2h')).toBe(7_200_000)
    expect(parseWindow('~1d')).toBe(86_400_000)
  })

  it('treats a bare number as minutes', () => {
    expect(parseWindow('~30')).toBe(1_800_000)
  })

  it('is case insensitive', () => {
    expect(parseWindow('~2H')).toBe(7_200_000)
  })

  it('rejects non-windows so they fall through to free text', () => {
    expect(parseWindow('~')).toBeNull()
    expect(parseWindow('~abc')).toBeNull()
    expect(parseWindow('~0')).toBeNull()
    expect(parseWindow('30m')).toBeNull()
  })
})

describe('parsePulseQuery', () => {
  it('returns an empty query for blank input', () => {
    expect(isEmptyQuery(parsePulseQuery(''))).toBe(true)
    expect(isEmptyQuery(parsePulseQuery('   '))).toBe(true)
  })

  it('parses ! as needs and !! as needs+working', () => {
    expect(parsePulseQuery('!').bands).toEqual(['needs'])
    expect(parsePulseQuery('!!').bands).toEqual(['needs', 'working'])
  })

  it('parses @project and #tag', () => {
    expect(parsePulseQuery('@anvil').project).toBe('anvil')
    expect(parsePulseQuery('#epic-run').tag).toBe('epic-run')
  })

  it('lowercases scopes', () => {
    expect(parsePulseQuery('@Anvil-MD').project).toBe('anvil-md')
    expect(parsePulseQuery('#Epic-Run').tag).toBe('epic-run')
  })

  it('is position independent and combines with AND', () => {
    const q = parsePulseQuery('ceiling @remote ~5m #epic !')
    expect(q.text).toBe('ceiling')
    expect(q.project).toBe('remote')
    expect(q.tag).toBe('epic')
    expect(q.windowMs).toBe(300_000)
    expect(q.bands).toEqual(['needs'])
  })

  it('keeps a bare sigil as free text rather than eating the query', () => {
    for (const sigil of ['@', '#', '&', ':', '$', '%']) {
      expect(parsePulseQuery(sigil).text).toBe(sigil)
    }
  })

  it('parses &host and :model', () => {
    expect(parsePulseQuery('&studio').host).toBe('studio')
    expect(parsePulseQuery(':opus').model).toBe('opus')
  })

  it('parses $cost and %context floors', () => {
    expect(parsePulseQuery('$1').minCostUsd).toBe(1)
    expect(parsePulseQuery('$0.5').minCostUsd).toBe(0.5)
    expect(parsePulseQuery('%80').minContextPct).toBe(80)
  })

  it('lets a non-numeric $ or % payload fall through to free text', () => {
    expect(parsePulseQuery('$abc').text).toBe('$abc')
    expect(parsePulseQuery('%abc').text).toBe('%abc')
    expect(parsePulseQuery('$abc').minCostUsd).toBeNull()
  })

  it('parses the whole sigil set in one query', () => {
    const q = parsePulseQuery('! @remote #epic ~30m $1 %80 &studio :opus ceiling')
    expect(q.bands).toEqual(['needs'])
    expect(q.project).toBe('remote')
    expect(q.tag).toBe('epic')
    expect(q.windowMs).toBe(1_800_000)
    expect(q.minCostUsd).toBe(1)
    expect(q.minContextPct).toBe(80)
    expect(q.host).toBe('studio')
    expect(q.model).toBe('opus')
    expect(q.text).toBe('ceiling')
  })

  it('keeps multi-word free text', () => {
    expect(parsePulseQuery('ceiling copy').text).toBe('ceiling copy')
  })

  it('last scope of a kind wins', () => {
    expect(parsePulseQuery('@a @b').project).toBe('b')
  })
})

describe('matchesPulseQuery', () => {
  const q = parsePulseQuery

  it('matches everything on an empty query', () => {
    expect(matchesPulseQuery(row(), q(''))).toBe(true)
  })

  it('filters by band', () => {
    expect(matchesPulseQuery(row({ band: 'needs' }), q('!'))).toBe(true)
    expect(matchesPulseQuery(row({ band: 'working' }), q('!'))).toBe(false)
    expect(matchesPulseQuery(row({ band: 'working' }), q('!!'))).toBe(true)
    expect(matchesPulseQuery(row({ band: 'idle' }), q('!!'))).toBe(false)
  })

  it('filters by project substring', () => {
    expect(matchesPulseQuery(row(), q('@remote'))).toBe(true)
    expect(matchesPulseQuery(row(), q('@anvil'))).toBe(false)
  })

  it('filters by tag substring', () => {
    expect(matchesPulseQuery(row(), q('#epic-run'))).toBe(true)
    expect(matchesPulseQuery(row({ tag: undefined }), q('#epic-run'))).toBe(false)
  })

  it('filters by time window', () => {
    expect(matchesPulseQuery(row({ ageMs: 60_000 }), q('~5m'))).toBe(true)
    expect(matchesPulseQuery(row({ ageMs: 600_000 }), q('~5m'))).toBe(false)
  })

  it('searches title, project, action and tag', () => {
    expect(matchesPulseQuery(row(), q('ceiling'))).toBe(true)
    expect(matchesPulseQuery(row(), q('remote-claude'))).toBe(true)
    expect(matchesPulseQuery(row(), q('rm "-rf"'))).toBe(true)
    expect(matchesPulseQuery(row(), q('worktree'))).toBe(true)
    expect(matchesPulseQuery(row(), q('nonsense'))).toBe(false)
  })

  it('requires EVERY free-text word to hit', () => {
    expect(matchesPulseQuery(row(), q('ceiling permission'))).toBe(true)
    expect(matchesPulseQuery(row(), q('ceiling nonsense'))).toBe(false)
  })

  it('filters by host and model', () => {
    const r = row({ host: 'studio', model: 'claude-opus-5' })
    expect(matchesPulseQuery(r, q('&studio'))).toBe(true)
    expect(matchesPulseQuery(r, q('&nas'))).toBe(false)
    expect(matchesPulseQuery(r, q(':opus'))).toBe(true)
    expect(matchesPulseQuery(r, q(':haiku'))).toBe(false)
  })

  it('treats a missing host/model as a non-match, never a wildcard', () => {
    expect(matchesPulseQuery(row({ host: undefined }), q('&studio'))).toBe(false)
    expect(matchesPulseQuery(row({ model: undefined }), q(':opus'))).toBe(false)
  })

  it('filters by cost and context floors, inclusive', () => {
    expect(matchesPulseQuery(row({ costUsd: 2 }), q('$1'))).toBe(true)
    expect(matchesPulseQuery(row({ costUsd: 1 }), q('$1'))).toBe(true)
    expect(matchesPulseQuery(row({ costUsd: 0.5 }), q('$1'))).toBe(false)
    expect(matchesPulseQuery(row({ contextPct: 92 }), q('%80'))).toBe(true)
    expect(matchesPulseQuery(row({ contextPct: 12 }), q('%80'))).toBe(false)
  })

  it('treats absent cost/context as zero rather than passing the floor', () => {
    expect(matchesPulseQuery(row({ costUsd: undefined }), q('$1'))).toBe(false)
    expect(matchesPulseQuery(row({ contextPct: undefined }), q('%80'))).toBe(false)
  })

  it('ANDs scopes together', () => {
    expect(matchesPulseQuery(row(), q('! @remote ~5m ceiling'))).toBe(true)
    expect(matchesPulseQuery(row({ band: 'idle' as PulseBand }), q('! @remote'))).toBe(false)
  })

  it('ANDs the whole sigil set', () => {
    const r = row({ costUsd: 3, contextPct: 90, host: 'studio', model: 'claude-opus-5' })
    expect(matchesPulseQuery(r, q('! @remote #worktree ~5m $1 %80 &studio :opus ceiling'))).toBe(true)
    expect(matchesPulseQuery(r, q('! @remote $99'))).toBe(false)
  })
})

describe('exclusion with -', () => {
  const q = parsePulseQuery

  it('excludes by free text', () => {
    expect(matchesPulseQuery(row(), q('-ceiling'))).toBe(false)
    expect(matchesPulseQuery(row(), q('-nonsense'))).toBe(true)
  })

  it('excludes by each scope sigil', () => {
    const r = row({ host: 'studio', model: 'claude-opus-5' })
    expect(matchesPulseQuery(r, q('-@remote'))).toBe(false)
    expect(matchesPulseQuery(r, q('-#worktree'))).toBe(false)
    expect(matchesPulseQuery(r, q('-&studio'))).toBe(false)
    expect(matchesPulseQuery(r, q('-:opus'))).toBe(false)
  })

  it('excludes a band', () => {
    expect(matchesPulseQuery(row({ band: 'needs' }), q('-!'))).toBe(false)
    expect(matchesPulseQuery(row({ band: 'idle' }), q('-!'))).toBe(true)
  })

  it('beats a positive match — exclusion always wins', () => {
    expect(matchesPulseQuery(row(), q('ceiling -@remote'))).toBe(false)
  })

  it('stacks several exclusions as an OR', () => {
    expect(matchesPulseQuery(row(), q('-@anvil -@remote'))).toBe(false)
    expect(matchesPulseQuery(row(), q('-@anvil -@gate'))).toBe(true)
  })

  it('treats a bare - as free text', () => {
    expect(parsePulseQuery('-').text).toBe('-')
  })

  it('counts as a non-empty query', () => {
    expect(isEmptyQuery(parsePulseQuery('-@anvil'))).toBe(false)
  })

  it('DOES swallow a shell flag — same as GitHub/Google — which is why quoting exists', () => {
    // `rm -rf` reads `-rf` as an exclusion. Documented, not accidental.
    expect(parsePulseQuery('rm -rf').not.text).toEqual(['rf'])
    expect(parsePulseQuery('rm "-rf"').not.text).toEqual([])
  })
})

describe('managed rows (+over)', () => {
  const q = parsePulseQuery
  const seat = row({ managed: true, band: 'working' })
  const mine = row({ managed: false, band: 'working' })

  it('hides machine-run rows by DEFAULT — Pulse answers "what am I working on"', () => {
    expect(matchesPulseQuery(seat, q(''))).toBe(false)
    expect(matchesPulseQuery(mine, q(''))).toBe(true)
  })

  it('treats an absent flag as not-managed rather than hiding it', () => {
    expect(matchesPulseQuery(row({ managed: undefined }), q(''))).toBe(true)
  })

  it('+over reveals them alongside everything else', () => {
    expect(matchesPulseQuery(seat, q('+over'))).toBe(true)
    expect(matchesPulseQuery(mine, q('+over'))).toBe(true)
  })

  it('+managed is an alias for +over', () => {
    expect(matchesPulseQuery(seat, q('+managed'))).toBe(true)
  })

  it('+over +only narrows to ONLY machine-run rows', () => {
    expect(matchesPulseQuery(seat, q('+over +only'))).toBe(true)
    expect(matchesPulseQuery(mine, q('+over +only'))).toBe(false)
  })

  it('stays hidden even when another filter would have matched', () => {
    // The default is not a search refinement -- it outranks a positive hit.
    expect(matchesPulseQuery(row({ managed: true }), q('! @remote'))).toBe(false)
  })

  it('counts as a non-empty query so the surface knows a filter is active', () => {
    expect(isEmptyQuery(q('+over'))).toBe(false)
  })

  it('lets an unknown + token fall through to free text', () => {
    expect(parsePulseQuery('+nonsense').text).toBe('+nonsense')
    expect(parsePulseQuery('+nonsense').includeManaged).toBe(false)
  })

  it('is case insensitive', () => {
    expect(parsePulseQuery('+OVER').includeManaged).toBe(true)
  })
})

describe('quoting', () => {
  it('keeps a quoted run together as one term', () => {
    expect(parsePulseQuery('"ceiling copy"').text).toBe('ceiling copy')
    expect(parsePulseQuery("'ceiling copy'").text).toBe('ceiling copy')
  })

  it('disarms every sigil inside quotes', () => {
    for (const raw of ['"@remote"', '"#tag"', '"$1"', '"%80"', '"&host"', '":opus"', '"~30m"', '"!"']) {
      const q = parsePulseQuery(raw)
      expect(q.project).toBeNull()
      expect(q.tag).toBeNull()
      expect(q.bands).toBeNull()
      expect(q.text).toBe(raw.slice(1, -1).toLowerCase())
    }
  })

  it('mixes quoted and unquoted terms', () => {
    const q = parsePulseQuery('@remote "-rf" ceiling')
    expect(q.project).toBe('remote')
    expect(q.text).toBe('-rf ceiling')
    expect(q.not.text).toEqual([])
  })

  it('drops an empty quoted term', () => {
    expect(parsePulseQuery('""').text).toBe('')
  })
})

describe('highlightRange', () => {
  it('is null without free text', () => {
    expect(highlightRange('epic-run', parsePulseQuery('!'))).toBeNull()
  })

  it('finds the first hit case-insensitively', () => {
    expect(highlightRange('epic-run ceiling', parsePulseQuery('CEILING'))).toEqual([9, 16])
  })

  it('is null when the word is absent from this field', () => {
    expect(highlightRange('epic-run', parsePulseQuery('permission'))).toBeNull()
  })
})

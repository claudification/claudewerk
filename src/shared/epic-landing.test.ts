import { describe, expect, test } from 'bun:test'
import {
  blocksResolution,
  type CardLanding,
  describeLanding,
  formatEscalations,
  holdsDependents,
  type LandingFacts,
  landingVerdict,
  parseEscalations,
  unresolvedLandings,
} from './epic-landing'

const FACTS: LandingFacts = { evidence: 'ahead', target: 'merged' }

const verdict = (over: Partial<LandingFacts> = {}) => landingVerdict({ ...FACTS, ...over })

describe('landingVerdict', () => {
  test('a branch local main does not contain is UNMERGED', () => {
    expect(verdict()).toBe('unmerged')
  })

  test('a branch main already contains, still a ref, is STANDING -- merged is only half of it', () => {
    // RESOLVED MEANS MERGED **AND** CLEANED UP. A branch merged and left behind
    // is half a resolution, and a run that "completes" over one has not.
    expect(verdict({ evidence: 'merged' })).toBe('standing')
  })

  test('a branch that is gone is LANDED -- worktree-remove.sh refuses to leave that state unmerged', () => {
    expect(verdict({ evidence: 'gone' })).toBe('landed')
  })

  test('an unscanned repo withholds NOTHING and claims nothing', () => {
    // The scan gates DISPATCH. Reading a timeout as "everything is unmerged"
    // would freeze every epic on the box; reading it as "everything landed"
    // would silently delete the gate.
    expect(verdict({ evidence: 'unscanned' })).toBe('unknown')
    expect(verdict({ evidence: 'unscanned', target: 'shipped' })).toBe('unknown')
  })

  describe('target -- the knob the engine finally reads', () => {
    test('pr is satisfied by anything the scan can say', () => {
      expect(verdict({ target: 'pr' })).toBe('landed')
      expect(verdict({ target: 'pr', evidence: 'merged' })).toBe('landed')
    })

    test('pr and merged genuinely disagree on the same facts', () => {
      expect(verdict({ target: 'pr' })).not.toBe(verdict({ target: 'merged' }))
    })

    test('shipped is at least merged -- the engine cannot verify a deploy, so it verifies the subset', () => {
      expect(verdict({ target: 'shipped' })).toBe('unmerged')
      expect(verdict({ target: 'shipped', evidence: 'gone' })).toBe('landed')
    })

    test('pr still refuses to claim a check it never ran', () => {
      // It has no remote to look at, so `unscanned` stays unknown rather than
      // being rounded up to delivered.
      expect(verdict({ target: 'pr', evidence: 'unscanned' })).toBe('unknown')
    })
  })
})

describe('what each verdict stops', () => {
  test('only UNMERGED withholds dependents -- tidiness never stops work moving', () => {
    expect(holdsDependents('unmerged')).toBe(true)
    expect(holdsDependents('standing')).toBe(false)
    expect(holdsDependents('landed')).toBe(false)
    expect(holdsDependents('unknown')).toBe(false)
  })

  test('BOTH failing verdicts stop the run being finished', () => {
    expect(blocksResolution('unmerged')).toBe(true)
    expect(blocksResolution('standing')).toBe(true)
    expect(blocksResolution('landed')).toBe(false)
    expect(blocksResolution('unknown')).toBe(false)
  })
})

const landing = (over: Partial<CardLanding> = {}): CardLanding => ({
  cardId: 'c1',
  branch: 'worktree-epic/e1/c1',
  verdict: 'unmerged',
  evidence: 'ahead',
  ...over,
})

describe('unresolvedLandings', () => {
  test('keeps only the blocking pair, in order', () => {
    const rows = [
      landing({ cardId: 'a', verdict: 'landed' }),
      landing({ cardId: 'b', verdict: 'unmerged' }),
      landing({ cardId: 'c', verdict: 'unknown' }),
      landing({ cardId: 'd', verdict: 'standing' }),
    ]
    expect(unresolvedLandings(rows).map(l => l.cardId)).toEqual(['b', 'd'])
  })
})

describe('describeLanding', () => {
  test('names the branch, because "go and merge it" is useless without one', () => {
    expect(describeLanding(landing())).toContain('worktree-epic/e1/c1')
  })

  test('the two verdicts read differently -- one needs a merge, one needs a cleanup', () => {
    expect(describeLanding(landing({ verdict: 'unmerged' }))).toContain('NOT on main')
    expect(describeLanding(landing({ verdict: 'standing' }))).toContain('worktree-remove.sh')
  })
})

describe('the escalation ledger codec', () => {
  test('round-trips', () => {
    const map = new Map([
      ['card-a', 3],
      ['card-b', 7],
    ])
    expect(parseEscalations(formatEscalations(map))).toEqual(map)
  })

  test('serialises SORTED, so the same set is the same bytes', () => {
    // `EpicBeatPatch` is pruned by scalar inequality: two spellings of one set
    // would write `run.md` every 45 seconds forever.
    const forward = formatEscalations(
      new Map([
        ['b', 1],
        ['a', 2],
      ]),
    )
    const backward = formatEscalations(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    )
    expect(forward).toBe(backward)
    expect(forward).toBe('a@2,b@1')
  })

  test('an empty ledger is the empty string, both ways', () => {
    expect(formatEscalations(new Map())).toBe('')
    expect(parseEscalations('')).toEqual(new Map())
    expect(parseEscalations(undefined)).toEqual(new Map())
  })

  test('a card id containing @ still parses -- the LAST @ is the separator', () => {
    expect(parseEscalations('we@rd@4').get('we@rd')).toBe(4)
  })

  test('garbage entries are dropped, never guessed at', () => {
    // A hand-edited run.md costs at most one extra wake, which is the cheap
    // direction to fail in.
    expect(parseEscalations('good@1,nogen,bad@x,@5,neg@-1')).toEqual(new Map([['good', 1]]))
  })
})

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

const FACTS: LandingFacts = {
  ledgerReady: true,
  evidence: 'committed',
  branchStanding: false,
  target: 'merged',
}

const verdict = (over: Partial<LandingFacts> = {}) => landingVerdict({ ...FACTS, ...over })

describe('landingVerdict', () => {
  test('commits on a branch with nothing on the trunk is UNMERGED at target=merged', () => {
    expect(verdict()).toBe('unmerged')
  })

  test('a merge commit on the trunk with the worktree gone is LANDED', () => {
    expect(verdict({ evidence: 'merged' })).toBe('landed')
  })

  test('merged but the branch is still a local ref is STANDING, not landed', () => {
    // RESOLVED MEANS MERGED **AND** CLEANED UP. A branch merged and left behind
    // is half a resolution, and a run that "completes" over one has not.
    expect(verdict({ evidence: 'merged', branchStanding: true })).toBe('standing')
  })

  test('a NULL worktree answer is not a clean one -- nobody looked, so nothing is claimed', () => {
    // The opposite reading would let a beat that skipped the 15s git scan certify
    // a directory it never opened.
    expect(verdict({ evidence: 'merged', branchStanding: null })).toBe('landed')
    expect(verdict({ evidence: 'committed', branchStanding: null })).toBe('unmerged')
  })

  describe('the two refusals to guess', () => {
    test('no commit ledger at all withholds NOTHING', () => {
      // A broker with no `commits.db` would otherwise read every card in every
      // run as unmerged -- and this gate holds dispatch, so that is every epic on
      // the box frozen on a missing file.
      expect(verdict({ ledgerReady: false })).toBe('unknown')
      expect(verdict({ ledgerReady: false, evidence: 'merged' })).toBe('unknown')
    })

    test('a card whose branch the ledger never saw is UNKNOWN, not unmerged', () => {
      // Question cards, decisions recorded on the board, cards the werk-planner
      // closed as already-done: none of them ever had a branch, and freezing a
      // run over work that was never meant to produce a commit is worse than the
      // failure this gate exists to catch.
      expect(verdict({ evidence: 'none' })).toBe('unknown')
    })
  })

  describe('target -- the knob the engine finally reads', () => {
    test('pr accepts commits on the branch', () => {
      expect(verdict({ target: 'pr' })).toBe('landed')
    })

    test('pr does NOT demand the cleanup half', () => {
      // `worktree-remove.sh` refuses while unmerged commits exist, which for a
      // `pr` run is the normal state. Demanding removal would demand a refusal.
      expect(verdict({ target: 'pr', branchStanding: true })).toBe('landed')
    })

    test('shipped is at least merged -- the engine cannot verify a deploy, so it verifies the subset', () => {
      expect(verdict({ target: 'shipped' })).toBe('unmerged')
      expect(verdict({ target: 'shipped', evidence: 'merged' })).toBe('landed')
    })

    test('pr and merged genuinely disagree on the same facts', () => {
      expect(verdict({ target: 'pr' })).not.toBe(verdict({ target: 'merged' }))
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
  evidence: 'committed',
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

  test('the two verdicts read differently -- one needs a merge, one needs an rm', () => {
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

import { describe, expect, it } from 'bun:test'
import { parsePromiseBlock } from '../../src/shared/promise-ledger'
import { applyPlan } from './apply'
import { deliveryHeadingShas } from './evidence'
import { type BackfillCard, type Evidence, isFact, isSearchableInProse, planFor } from './join'

const CUTOFF = '2026-08-21'

const filed = (over: Partial<BackfillCard> = {}): BackfillCard => ({
  // Long enough to be searchable in prose, on purpose: a short id is discarded
  // before the commit-message pass, which is its own test below rather than a
  // trap sitting under every other fixture here.
  id: 'old-card-from-the-before-times',
  status: 'done',
  created: '2026-07-01T10:00:00.000Z',
  hasPromise: false,
  ...over,
})

const merge: Evidence = { kind: 'branch-merge', commits: [{ sha: 'a'.repeat(40), subject: 'Merge branch x' }] }
const mention: Evidence = { kind: 'commit-message', commits: [{ sha: 'b'.repeat(40), subject: 'feat: thing' }] }

function card(body: string[] = [], front: string[] = []): string {
  return ['---', 'title: "A card"', 'status: done', ...front, '---', '', ...body, ''].join('\n')
}

describe('planFor -- biased toward writing nothing', () => {
  it('only ever touches a card filed as finished', () => {
    for (const status of ['open', 'in-review', 'inbox', 'in-progress']) {
      expect(planFor(filed({ status }), merge, CUTOFF).action).toBe('skip')
    }
    expect(planFor(filed({ status: 'archived' }), merge, CUTOFF).action).toBe('record')
  })

  it('a branch merge is a FACT -- recorded without the inferred stamp', () => {
    const plan = planFor(filed(), merge, CUTOFF)
    expect(plan).toMatchObject({ action: 'record', inferred: false, why: 'branch-merge' })
    expect(isFact('branch-merge')).toBe(true)
  })

  it('a commit-message match is INFERENCE and is stamped as such', () => {
    const plan = planFor(filed({ id: 'a-card-id-long-enough-to-search-for' }), mention, CUTOFF)
    expect(plan).toMatchObject({ action: 'record', inferred: true, why: 'commit-message' })
    expect(isFact('commit-message')).toBe(false)
    expect(isFact('built-section')).toBe(false)
  })

  it('no evidence + created before the cutoff = amnesty', () => {
    expect(planFor(filed(), null, CUTOFF)).toMatchObject({ action: 'amnesty', agreed: '2026-07-01' })
  })

  it('NO AMNESTY for a card created on or after the ledger -- it stays accused', () => {
    // The single rule that stops this being a blanket mute. A card written once
    // the ledger existed COULD have carried a promise, so its empty `closes:` is
    // a real finding and the red row is correct.
    expect(planFor(filed({ created: '2026-08-21T00:00:01.000Z' }), null, CUTOFF).action).toBe('skip')
    expect(planFor(filed({ created: '2026-09-02T00:00:00.000Z' }), null, CUTOFF).action).toBe('skip')
  })

  it('NO AMNESTY without a date -- an excuse needs a reason', () => {
    expect(planFor(filed({ created: null }), null, CUTOFF).action).toBe('skip')
  })

  it('NO AMNESTY over a promise block that is already there and empty', () => {
    // Somebody, or the engine, made a promise here and nothing backs it. That is
    // precisely the row the ledger exists to print; stamping `pre_ledger` over
    // the top would erase the finding rather than answer it.
    const plan = planFor(filed({ hasPromise: true }), null, CUTOFF)
    expect(plan.action).toBe('skip')
    expect(plan.why).toContain('a real finding')
  })

  it('evidence still wins on a card that already has a block -- appendCloses is idempotent', () => {
    expect(planFor(filed({ hasPromise: true }), merge, CUTOFF).action).toBe('record')
  })

  it('falls back to the cutoff for `agreed:` when the card has no created date', () => {
    expect(planFor(filed({ created: null }), merge, CUTOFF)).toMatchObject({ agreed: CUTOFF })
  })
})

describe('a generic card id is never matched against prose', () => {
  it('rejects every id that produced garbage in a measured dry run', () => {
    // Run 1: `bug` matched 12 commits, `backup` 10 -- on the English word alone.
    expect(isSearchableInProse('bug')).toBe(false)
    expect(isSearchableInProse('backup')).toBe(false)
    // Run 2, at >= 12 chars: still noise. `project-tasks` matched 12 commits
    // about the project board; `task-batch-selector` 6 about a perf pass.
    expect(isSearchableInProse('project-tasks')).toBe(false)
    expect(isSearchableInProse('task-batch-selector')).toBe(false)
    // Run 3, at >= 24: every match was 1-2 commits and every one was plausible.
    expect(isSearchableInProse('bun-fs-watch-stale-filename-retest-on-bun-14')).toBe(true)
    expect(isSearchableInProse('werk-fs-watch-contract-test-timeout-guillotine')).toBe(true)
    // Long but not a slug -- a single word is not a card id.
    expect(isSearchableInProse('averylongwordwithnodashesatall')).toBe(false)
  })

  it('DISCARDS the prose evidence and falls through to amnesty -- it does not dead-end', () => {
    // `bug` having no usable evidence is not a reason to leave it accused. It is
    // a pre-ledger card like the other 260 and it gets the same amnesty.
    expect(planFor(filed({ id: 'bug' }), mention, CUTOFF).action).toBe('amnesty')
  })

  it('but a BRANCH MERGE is still honoured for a short id -- it matches an exact branch name', () => {
    expect(planFor(filed({ id: 'bug' }), merge, CUTOFF)).toMatchObject({ action: 'record', inferred: false })
  })

  it('and a BUILT-SECTION claim is honoured for a short id -- it never searched for the id', () => {
    const built: Evidence = { kind: 'built-section', commits: [{ sha: 'c'.repeat(40) }] }
    expect(planFor(filed({ id: 'bug' }), built, CUTOFF)).toMatchObject({ action: 'record', inferred: true })
  })
})

describe('applyPlan -- line surgery, refusals never silent', () => {
  it('an amnesty stamps pre_ledger and claims NOTHING', () => {
    const out = applyPlan(card(), { action: 'amnesty', agreed: '2026-07-01', why: 'old' })
    expect(out.refused).toBeNull()
    expect(out.changed).toBe(true)
    expect(out.added).toEqual([])
    const block = parsePromiseBlock(out.text)
    expect(block?.preLedger).toBe(true)
    expect(block?.closes).toEqual([])
    expect(block?.inferred).toBe(false)
  })

  it('a recorded FACT carries no inferred stamp; an inferred one does', () => {
    const fact = applyPlan(card(), {
      action: 'record',
      commits: merge.commits,
      inferred: false,
      agreed: '2026-07-01',
      why: 'branch-merge',
    })
    expect(parsePromiseBlock(fact.text)?.inferred).toBe(false)
    expect(parsePromiseBlock(fact.text)?.closes).toEqual([merge.commits[0].sha])

    const guess = applyPlan(card(), {
      action: 'record',
      commits: mention.commits,
      inferred: true,
      agreed: '2026-07-01',
      why: 'commit-message',
    })
    expect(parsePromiseBlock(guess.text)?.inferred).toBe(true)
  })

  it('is IDEMPOTENT -- a second pass over its own output changes nothing', () => {
    const plan = {
      action: 'record' as const,
      commits: merge.commits,
      inferred: false,
      agreed: '2026-07-01',
      why: 'branch-merge',
    }
    const first = applyPlan(card(), plan)
    const second = applyPlan(first.text, plan)
    expect(second.changed).toBe(false)
    expect(second.added).toEqual([])
    expect(second.text).toBe(first.text)
  })

  it('refuses a card it cannot write, with the reason, and returns the ORIGINAL bytes', () => {
    const mixed = '---\r\ntitle: x\r\nstatus: done\n---\r\n\r\nbody\r\n'
    const out = applyPlan(mixed, { action: 'amnesty', agreed: '2026-07-01', why: 'old' })
    expect(out.text).toBe(mixed)
    expect(out.changed).toBe(false)
    expect(out.refused).toBe('card mixes CRLF and LF line endings')
  })

  it('a skip never touches a byte', () => {
    const text = card()
    expect(applyPlan(text, { action: 'skip', why: 'nope' })).toMatchObject({ text, changed: false, added: [] })
  })
})

describe('deliveryHeadingShas -- the heading line only, because prose wanders', () => {
  it('takes the shas the card states on its delivery heading', () => {
    expect(deliveryHeadingShas(card(['## BUILT -- O2, as decided. `2ba978d0`']))).toEqual(['2ba978d0'])
    expect(deliveryHeadingShas(card(['## WHAT SHIPPED (implementer, 4869d5ac + 5ec7e6d4)']))).toEqual([
      '4869d5ac',
      '5ec7e6d4',
    ])
  })

  it("IGNORES the section body -- that is where another card's commits get recounted", () => {
    // Measured, not hypothetical: `wall-copy-affordance` recounts an integration
    // in its BUILT section and a whole-section sweep filed SEVEN shas against
    // it, three of which belong to other cards that had earned their own rows.
    const text = card([
      '## WHAT SHIPPED (implementer, 4869d5ac)',
      '',
      'What arrived: `wall-pane-order-and-sotu-scope` (0cb0232f),',
      '`gate-cmdrunner-blocks-the-mcp-host` (7854b49a).',
    ])
    expect(deliveryHeadingShas(text)).toEqual(['4869d5ac'])
  })

  it('ignores prose shas entirely when the card never claims delivery', () => {
    expect(deliveryHeadingShas(card(['## Plan', 'we will branch from `dc2bf89c`']))).toEqual([])
  })

  it('a hex-shaped token that is not a commit survives here and dies at the git check', () => {
    // Shape is never proof. `deliveryHeadingShas` is a text scan by design and
    // `resolveOnBase` is the thing that asks git whether the object exists.
    expect(deliveryHeadingShas(card(['## SHIPPED 20260821 -- `deadbeef`']))).toEqual(['20260821', 'deadbeef'])
  })
})

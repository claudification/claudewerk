import { describe, expect, it } from 'bun:test'
import {
  hasVerdictSection,
  renderVerdictSection,
  upsertVerdictSection,
  VERDICT_HEADING,
  type VerdictInput,
  verdictDecisionFor,
} from './card-verdict'

const APPROVAL: VerdictInput = {
  decision: 'APPROVED',
  by: 'conv_guard',
  at: '2026-08-22T12:00:00.000Z',
  summary: 'Re-ran `bun run test` and `bun run typecheck` on the merge with main. Both green.',
}

describe('which moves carry a verdict', () => {
  it('leaving in-review for done is an approval', () => {
    expect(verdictDecisionFor('in-review', 'done')).toBe('APPROVED')
  })

  it('leaving in-review for in-progress or open is a bounce', () => {
    expect(verdictDecisionFor('in-review', 'in-progress')).toBe('BOUNCED')
    expect(verdictDecisionFor('in-review', 'open')).toBe('BOUNCED')
  })

  it('a card ENTERING in-review carries none -- the worker is not the verifier', () => {
    expect(verdictDecisionFor('in-progress', 'in-review')).toBeNull()
  })

  /**
   * Every other move on the board has to stay ungated or the board seizes up: a
   * werk-master answering a question card moves it open -> done, and it reviewed
   * nothing doing that.
   */
  it('no other move carries one, including a straight open -> done', () => {
    expect(verdictDecisionFor('open', 'done')).toBeNull()
    expect(verdictDecisionFor('inbox', 'open')).toBeNull()
    expect(verdictDecisionFor('done', 'archived')).toBeNull()
  })

  /** Archiving out of in-review is a DROP, not a judgement on the work. */
  it('in-review -> archived is a drop, not a verdict', () => {
    expect(verdictDecisionFor('in-review', 'archived')).toBeNull()
  })
})

describe('the rendered section', () => {
  it('leads with the decision, the author and the time -- all machine-supplied', () => {
    const s = renderVerdictSection(APPROVAL)
    expect(s.startsWith(VERDICT_HEADING)).toBe(true)
    expect(s).toContain('**APPROVED** by `conv_guard` at 2026-08-22T12:00:00.000Z')
    expect(s).toContain('Both green.')
  })

  it('omits caveats and notes when there are none', () => {
    const s = renderVerdictSection(APPROVAL)
    expect(s).not.toContain('Caveats')
    expect(s).not.toContain('Notes')
  })

  it('carries caveats and notes when there are', () => {
    const s = renderVerdictSection({ ...APPROVAL, caveats: 'needs a deploy', notes: 'left the worktree' })
    expect(s).toContain('**Caveats:** needs a deploy')
    expect(s).toContain('**Notes:** left the worktree')
  })
})

describe('putting it on a body', () => {
  it('appends at the end of a card that has none', () => {
    const out = upsertVerdictSection('## The spec\n\nbuild it\n', renderVerdictSection(APPROVAL))
    expect(out).toContain('## The spec')
    expect(out).toContain('build it')
    expect(out.indexOf(VERDICT_HEADING)).toBeGreaterThan(out.indexOf('## The spec'))
    expect(out.endsWith('\n')).toBe(true)
  })

  it('handles an empty body', () => {
    expect(upsertVerdictSection('', renderVerdictSection(APPROVAL)).startsWith(VERDICT_HEADING)).toBe(true)
  })

  /**
   * A card bounced and re-reviewed three times would otherwise grow three
   * verdicts, and a reader would have to work out which one is current.
   */
  it('REPLACES an existing verdict rather than stacking a second one', () => {
    const first = upsertVerdictSection(
      '## The spec\n\nbuild it\n',
      renderVerdictSection({ ...APPROVAL, decision: 'BOUNCED', summary: 'test:web never ran' }),
    )
    const second = upsertVerdictSection(first, renderVerdictSection(APPROVAL))
    expect(second.split(VERDICT_HEADING).length - 1).toBe(1)
    expect(second).toContain('Both green.')
    expect(second).not.toContain('test:web never ran')
  })

  it('leaves every other section intact, including one AFTER the verdict', () => {
    const body = `## The spec\n\nbuild it\n\n${renderVerdictSection(APPROVAL)}\n\n## Guard Findings\n\nold notes\n`
    const out = upsertVerdictSection(
      body,
      renderVerdictSection({ ...APPROVAL, decision: 'BOUNCED', summary: 'suite red' }),
    )
    expect(out).toContain('## The spec')
    expect(out).toContain('## Guard Findings')
    expect(out).toContain('old notes')
    expect(out).toContain('suite red')
    expect(out).not.toContain('Both green.')
  })

  it('upgrades a hand-written verdict in place', () => {
    const body = '## The spec\n\nbuild it\n\n## Verdict\n\nAPPROVED, trust me\n'
    expect(hasVerdictSection(body)).toBe(true)
    const out = upsertVerdictSection(body, renderVerdictSection(APPROVAL))
    expect(out).not.toContain('trust me')
    expect(out).toContain('**APPROVED** by `conv_guard`')
  })

  it('a body with no verdict says so', () => {
    expect(hasVerdictSection('## The spec\n\nbuild it\n')).toBe(false)
  })
})

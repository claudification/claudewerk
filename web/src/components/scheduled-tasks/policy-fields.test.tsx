/**
 * Policy fields rendering.
 *
 * Each control here changes what happens when nobody is watching, so the hints
 * have to state the consequence, not just name the setting. These assertions
 * pin that the DEFAULTS are the safe ones and that the hint text matches the
 * selected mode.
 */

import { DEFAULT_SCHEDULE_SPAWN } from '@shared/scheduled-task'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PolicyFields, type PolicyValue } from './policy-fields'

const value = (over: Partial<PolicyValue> = {}): PolicyValue => ({
  spawn: { ...DEFAULT_SCHEDULE_SPAWN },
  overlap: 'skip',
  catchUp: 'skip',
  ...over,
})

const render = (v: PolicyValue) => renderToStaticMarkup(<PolicyFields value={v} onChange={() => {}} />)

describe('PolicyFields', () => {
  it('offers all four decisions', () => {
    const html = render(value())
    expect(html).toContain('Run type')
    expect(html).toContain('If the previous run is still going')
    expect(html).toContain('If a run was missed')
    expect(html).toContain('Stop after N runs')
  })

  it('the default run type is ad-hoc, and says what that means', () => {
    expect(render(value())).toContain('runs the prompt, then exits')
  })

  it('leaveRunning flips it to persistent', () => {
    const html = render(value({ spawn: { adHoc: true, leaveRunning: true } }))
    expect(html).toContain('stays open after the prompt finishes')
  })

  it('explains the overlap choice in terms of consequence', () => {
    expect(render(value({ overlap: 'skip' }))).toContain('Skip this fire and record why')
    expect(render(value({ overlap: 'parallel' }))).toContain('can overlap')
  })

  it('explains the catch-up choice, including why skip is the default', () => {
    expect(render(value({ catchUp: 'skip' }))).toContain('Waking to a queue is worse than a gap')
    expect(render(value({ catchUp: 'once' }))).toContain('less than 6 hours old')
  })

  it('shows an unset run cap as unlimited', () => {
    expect(render(value())).toContain('unlimited')
  })

  it('renders a set run cap', () => {
    expect(render(value({ maxRuns: 10 }))).toContain('10')
  })
})

/**
 * @vitest-environment node
 */
/**
 * Schedule list rendering.
 *
 * The row has one job: tell you at a glance whether this schedule is going to
 * run, and when. The cases worth pinning are the ones where it will NOT run --
 * a row that shows a hopeful next-fire time for a dead schedule is worse than
 * one that says "expired".
 */

import type { ScheduledTask } from '@shared/scheduled-task'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScheduleList } from './schedule-list'

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sch_1',
    name: 'nightly audit',
    enabled: true,
    projectUri: 'claude:///Users/jonas/projects/remote-claude',
    cwd: '/Users/jonas/projects/remote-claude',
    cron: '0 9 * * 1-5',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'go',
    spawn: {},
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

const render = (tasks: ScheduledTask[]) => renderToStaticMarkup(<ScheduleList tasks={tasks} onSelect={() => {}} />)

describe('ScheduleList', () => {
  it('says so when there is nothing scheduled', () => {
    expect(render([])).toContain('No scheduled tasks yet')
  })

  it('shows the name and a plain-English cadence, not a raw cron', () => {
    const html = render([task()])
    expect(html).toContain('nightly audit')
    expect(html).toContain('Every weekday at 09:00')
    expect(html).toContain('Europe/Berlin')
  })

  it('groups by project', () => {
    const html = render([task(), task({ id: 'sch_2', projectUri: 'claude:///other', name: 'other job' })])
    expect(html).toContain('remote-claude')
    expect(html).toContain('other')
  })

  it('surfaces a failing streak', () => {
    expect(render([task({ consecutiveFailures: 3 })])).toContain('3x fail')
  })

  it('a disabled schedule says disabled instead of showing a next run', () => {
    expect(render([task({ enabled: false })])).toContain('disabled')
  })

  it('an exhausted schedule reports how many runs it did', () => {
    expect(render([task({ maxRuns: 5, runCount: 5 })])).toContain('5/5 runs')
  })

  it('an expired schedule says expired', () => {
    expect(render([task({ endAt: 1000 })])).toContain('expired')
  })

  it('an unparseable cron says so rather than pretending', () => {
    const html = render([task({ cron: 'nonsense' })])
    expect(html).toContain('Invalid')
  })

  it('renders an upcoming run with a relative countdown', () => {
    // Every minute -- guaranteed to have a next fire regardless of when tests run.
    const html = render([task({ cron: '* * * * *' })])
    expect(html).toMatch(/in \d+ (seconds?|minutes?)|now/)
  })
})

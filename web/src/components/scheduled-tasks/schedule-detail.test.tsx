/**
 * Schedule detail rendering.
 *
 * The header exists to answer "is this thing actually working?" without opening
 * anything: armed or not, when it next runs in the reader's own clock, and
 * whether it has been failing. Those are what these assertions pin.
 */

import type { ScheduledTask } from '@shared/scheduled-task'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScheduleDetail } from './schedule-detail'

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sch_1',
    name: 'nightly audit',
    enabled: true,
    projectUri: 'claude:///p',
    cwd: '/p',
    cron: '0 9 * * 1-5',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'Audit the repo and report.',
    spawn: {},
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

const render = (t: ScheduledTask) =>
  renderToStaticMarkup(<ScheduleDetail task={t} onEdit={() => {}} onDeleted={() => {}} />)

describe('ScheduleDetail', () => {
  it('shows the name, the cadence in English, and the zone', () => {
    const html = render(task())
    expect(html).toContain('nightly audit')
    expect(html).toContain('Every weekday at 09:00')
    expect(html).toContain('Europe/Berlin')
  })

  it('shows the prompt -- it is what the schedule actually does', () => {
    expect(render(task())).toContain('Audit the repo and report.')
  })

  it('offers the three actions you reach for', () => {
    const html = render(task())
    expect(html).toContain('Run now')
    expect(html).toContain('Edit')
    expect(html).toContain('Delete')
  })

  it('the arm/disarm action reflects current state', () => {
    expect(render(task({ enabled: true }))).toContain('Disable')
    expect(render(task({ enabled: false }))).toContain('Enable')
  })

  it('a disabled schedule reports disabled instead of a next run', () => {
    expect(render(task({ enabled: false }))).toContain('disabled')
  })

  it('pluralises the run count honestly', () => {
    expect(render(task({ runCount: 1 }))).toContain('1 run')
    expect(render(task({ runCount: 4 }))).toContain('4 runs')
  })

  it('calls out a failing streak', () => {
    expect(render(task({ consecutiveFailures: 2 }))).toContain('2 failing in a row')
  })

  it('says when it will stop', () => {
    expect(render(task({ maxRuns: 10 }))).toContain('stops after 10')
  })

  it('delete asks for confirmation rather than firing immediately', () => {
    // The confirm step only appears after a click; the initial render must not
    // show a live "Really delete?" affordance.
    expect(render(task())).not.toContain('Really delete?')
  })
})

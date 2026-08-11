/**
 * Schedule editor rendering.
 *
 * Two things matter structurally: the prompt is the hero field (it is the only
 * input with no defensible default), and Save is BLOCKED until the schedule is
 * actually runnable -- a saved schedule that can never fire is the failure this
 * whole feature exists to avoid.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScheduleEditor } from './schedule-editor'
import { blankDraft, draftProblem, type ScheduleDraft } from './use-schedule-draft'

function draft(over: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return { ...blankDraft('claude:///p', '/p'), name: 'nightly', prompt: 'do the thing', ...over }
}

const render = (d: ScheduleDraft, error?: string | null) =>
  renderToStaticMarkup(
    <ScheduleEditor draft={d} patch={() => {}} onSave={() => {}} onCancel={() => {}} error={error} />,
  )

describe('draftProblem', () => {
  it('names the missing piece rather than saying "invalid"', () => {
    expect(draftProblem(draft({ name: '' }))).toContain('name')
    expect(draftProblem(draft({ prompt: '' }))).toContain('prompt')
    expect(draftProblem(draft({ cron: '' }))).toContain('schedule')
    expect(draftProblem(draft({ cwd: '' }))).toContain('working directory')
  })

  it('whitespace does not count as filled in', () => {
    expect(draftProblem(draft({ prompt: '   ' }))).not.toBeNull()
  })

  it('a complete draft has no problem', () => {
    expect(draftProblem(draft())).toBeNull()
  })
})

describe('ScheduleEditor', () => {
  it('opens on the basic tab with the fields that have no defaults', () => {
    const html = render(draft())
    expect(html).toContain('Prompt')
    expect(html).toContain('Name')
    expect(html).toContain('Schedule')
    expect(html).toContain('Working directory')
  })

  it('gives the prompt the most room -- it is the payload', () => {
    expect(render(draft())).toContain('<textarea')
  })

  it('shows all three tabs', () => {
    const html = render(draft())
    expect(html).toContain('basic')
    expect(html).toContain('launch')
    expect(html).toContain('policy')
  })

  it('describes the cron in English so a typo is visible', () => {
    expect(render(draft({ cron: '0 9 * * 1-5' }))).toContain('Every weekday at 09:00')
  })

  it('a bad cron reads as invalid instead of silently accepted', () => {
    expect(render(draft({ cron: '99 * * * *' }))).toContain('Invalid')
  })

  it('blocks Save while something required is missing, and says what', () => {
    const html = render(draft({ prompt: '' }))
    expect(html).toContain('disabled')
    expect(html).toContain('a prompt')
  })

  it('enables Save once the draft is runnable', () => {
    expect(render(draft())).not.toContain('cursor-not-allowed')
  })

  it("surfaces the server's error over the local hint", () => {
    expect(render(draft(), 'cron: minute out of range')).toContain('cron: minute out of range')
  })
})

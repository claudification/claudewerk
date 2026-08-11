/**
 * Browse pane rendering.
 *
 * The empty state is the one users hit first, so it has to explain what a
 * scheduled task IS rather than just saying "nothing here". The project filter
 * has to be visible and escapable -- a filtered list that looks unfiltered is
 * how you conclude your schedules vanished.
 */

import type { ScheduledTask } from '@shared/scheduled-task'
import { cleanup, render as renderClient } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowsePane } from './browse-pane'
import { useScheduledTasksModalStore } from './modal-state'
import { useScheduledTasksStore } from './store'

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sch_1',
    name: 'nightly audit',
    enabled: true,
    projectUri: 'claude:///alpha',
    cwd: '/alpha',
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

// A CLIENT render, not SSR: zustand's server snapshot is `getInitialState`, so
// anything pushed in with `setState` is invisible to `renderToStaticMarkup`.
const render = () => renderClient(<BrowsePane onCreate={() => {}} />).container.innerHTML

afterEach(cleanup)

beforeEach(() => {
  useScheduledTasksStore.setState({ tasks: [], loaded: true, runs: {} })
  useScheduledTasksModalStore.setState({ projectFilter: undefined, selectedId: undefined, mode: 'browse' })
})

describe('BrowsePane', () => {
  it('explains what a scheduled task is when there are none', () => {
    const html = render()
    expect(html).toContain('Nothing scheduled here yet')
    expect(html).toContain('unattended')
  })

  it('always offers a way to create one', () => {
    expect(render()).toContain('+ New schedule')
  })

  it('selects the first schedule when nothing is explicitly selected', () => {
    useScheduledTasksStore.setState({ tasks: [task(), task({ id: 'sch_2', name: 'second' })] })
    const html = render()
    // The detail pane shows the first one's prompt block.
    expect(html).toContain('nightly audit')
    expect(html).toContain('History')
  })

  it('honours an explicit selection', () => {
    useScheduledTasksStore.setState({ tasks: [task(), task({ id: 'sch_2', name: 'second' })] })
    useScheduledTasksModalStore.setState({ selectedId: 'sch_2' })
    expect(render()).toContain('second')
  })

  it('filters to one project and says it is filtering', () => {
    useScheduledTasksStore.setState({
      tasks: [task(), task({ id: 'sch_2', name: 'beta job', projectUri: 'claude:///beta' })],
    })
    useScheduledTasksModalStore.setState({ projectFilter: 'claude:///beta' })

    const html = render()
    expect(html).toContain('filtered:')
    expect(html).toContain('show all')
    expect(html).toContain('beta job')
    expect(html).not.toContain('nightly audit')
  })

  it('shows every project when unfiltered', () => {
    useScheduledTasksStore.setState({
      tasks: [task(), task({ id: 'sch_2', name: 'beta job', projectUri: 'claude:///beta' })],
    })
    const html = render()
    expect(html).toContain('nightly audit')
    expect(html).toContain('beta job')
  })
})

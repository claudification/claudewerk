import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RequestCard, useCardDeepLink, useCardResolver } from './use-card-deeplink'
import type { ProjectTask, ProjectTaskMeta } from './use-project'

const meta = (slug: string, status: ProjectTaskMeta['status'] = 'open'): ProjectTaskMeta => ({
  slug,
  status,
  title: slug,
  priority: 'medium',
  tags: [],
  refs: [],
  created: '2026-08-11T00:00:00.000Z',
  bodyPreview: '',
  mtime: 1,
})

/** The board's authoritative by-id read, keyed by id alone -- a card's lane is
 *  not part of its address, and the panel's cache is not part of the answer. */
function fakeReadTask(known: Record<string, ProjectTaskMeta['status']>) {
  return vi.fn(async (id: string) => (known[id] ? ({ ...meta(id, known[id]), body: 'body' } as ProjectTask) : null))
}

function harness(readTask: ReturnType<typeof fakeReadTask>) {
  const opened: ProjectTask[] = []
  const missed: string[] = []
  let request: RequestCard = () => {}
  function Probe({ ready }: { ready: boolean }) {
    request = useCardResolver({
      ready,
      readTask,
      onOpen: t => {
        opened.push(t)
      },
      onMissing: id => {
        missed.push(id)
      },
    })
    return null
  }
  return { opened, missed, Probe, ask: (...args: Parameters<RequestCard>) => act(() => request(...args)) }
}

afterEach(cleanup)

describe('useCardResolver', () => {
  it('opens a card requested before the project resolves (the load race)', async () => {
    const { opened, Probe, ask } = harness(fakeReadTask({ 'fix-thing': 'in-progress' }))
    const view = render(<Probe ready={false} />)
    ask('fix-thing') // no project to ask yet -- must WAIT, not drop
    expect(opened).toHaveLength(0)

    view.rerender(<Probe ready={true} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].slug).toBe('fix-thing')
  })

  it('opens a card whatever lane it is in -- the lane is never part of the request', async () => {
    const readTask = fakeReadTask({ moved: 'done' })
    const { opened, Probe, ask } = harness(readTask)
    // The link that got us here may have said `open`; it does not matter.
    render(<Probe ready={true} />)
    ask('moved')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledTimes(1)
    expect(readTask).toHaveBeenCalledWith('moved')
    expect(opened[0].status).toBe('done')
  })

  it('reads a card exactly once (no stale-lane retry to pay for)', async () => {
    const readTask = fakeReadTask({ card: 'archived' })
    const { opened, Probe, ask } = harness(readTask)
    render(<Probe ready={true} />)
    ask('card')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledTimes(1)
  })

  it('opens a card the panel has never cached -- the BOARD is the authority', async () => {
    // The regression: an agent writes a card while this panel is backgrounded,
    // so no `project_changed` ever lands and the cached manifest stays stale.
    // The card is on disk and `get` returns it, but the resolver used to treat
    // its own cache as proof of existence and drop the request in silence --
    // clicking the link did nothing, forever. Nothing is cached here at all.
    const readTask = fakeReadTask({ 'backup-00-master': 'open' })
    const { opened, Probe, ask } = harness(readTask)
    render(<Probe ready={true} />)
    ask('backup-00-master')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].slug).toBe('backup-00-master')
  })

  it('REPORTS a card the board genuinely does not have, never silently', async () => {
    const { opened, missed, Probe, ask } = harness(fakeReadTask({}))
    render(<Probe ready={true} />)
    ask('deleted')
    await waitFor(() => expect(missed).toEqual(['deleted']))
    expect(opened).toHaveLength(0)
  })

  it('reports a failed read instead of swallowing the error', async () => {
    const readTask = vi.fn(async () => {
      throw new Error('sentinel offline')
    })
    const { opened, missed, Probe, ask } = harness(readTask as unknown as ReturnType<typeof fakeReadTask>)
    render(<Probe ready={true} />)
    ask('some-card')
    await waitFor(() => expect(missed).toEqual(['some-card']))
    expect(opened).toHaveLength(0)
  })
})

describe('useCardDeepLink', () => {
  it('honours the open-project-task event (push notification / hash route)', async () => {
    const opened: ProjectTask[] = []
    const readTask = fakeReadTask({ 'from-push': 'open' })
    function Probe() {
      useCardDeepLink({
        ready: true,
        readTask,
        onOpen: t => {
          opened.push(t)
        },
      })
      return null
    }
    render(<Probe />)
    act(() => {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: 'from-push' } }))
    })
    await waitFor(() => expect(opened).toHaveLength(1))
  })
})

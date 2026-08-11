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

/** A readTask keyed by id alone -- a card's lane is not part of its address. */
function fakeReadTask(known: Record<string, ProjectTaskMeta['status']>) {
  return vi.fn(async (id: string) =>
    known[id] ? ({ ...meta(id, known[id]), body: 'body' } as ProjectTask) : null,
  )
}

function harness(readTask: ReturnType<typeof fakeReadTask>) {
  const opened: ProjectTask[] = []
  let request: RequestCard = () => {}
  function Probe({ tasks, loading }: { tasks: ProjectTaskMeta[]; loading: boolean }) {
    request = useCardResolver({
      tasks,
      loading,
      readTask,
      onOpen: t => {
        opened.push(t)
      },
    })
    return null
  }
  return { opened, Probe, ask: (...args: Parameters<RequestCard>) => act(() => request(...args)) }
}

afterEach(cleanup)

describe('useCardResolver', () => {
  it('opens a card requested before the manifest lands (the load race)', async () => {
    const { opened, Probe, ask } = harness(fakeReadTask({ 'fix-thing': 'in-progress' }))
    const view = render(<Probe tasks={[]} loading={true} />)
    ask('fix-thing') // nothing loaded yet -- must WAIT, not drop
    expect(opened).toHaveLength(0)

    view.rerender(<Probe tasks={[meta('fix-thing', 'in-progress')]} loading={false} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].slug).toBe('fix-thing')
  })

  it('opens a card whatever lane it is in -- the lane is never part of the request', async () => {
    const readTask = fakeReadTask({ moved: 'done' })
    const { opened, Probe, ask } = harness(readTask)
    // The link that got us here may have said `open`; it does not matter.
    render(<Probe tasks={[meta('moved', 'done')]} loading={false} />)
    ask('moved')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledTimes(1)
    expect(readTask).toHaveBeenCalledWith('moved')
    expect(opened[0].status).toBe('done')
  })

  it('reads a card exactly once (no stale-lane retry to pay for)', async () => {
    const readTask = fakeReadTask({ card: 'archived' })
    const { opened, Probe, ask } = harness(readTask)
    render(<Probe tasks={[meta('card', 'archived')]} loading={false} />)
    ask('card')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledTimes(1)
  })

  it('drops a request for a card the loaded project does not have', () => {
    const { opened, Probe, ask } = harness(fakeReadTask({}))
    render(<Probe tasks={[meta('something-else')]} loading={false} />)
    ask('deleted')
    expect(opened).toHaveLength(0)
  })
})

describe('useCardDeepLink', () => {
  it('honours the open-project-task event (push notification / hash route)', async () => {
    const opened: ProjectTask[] = []
    const readTask = fakeReadTask({ 'from-push': 'open' })
    function Probe() {
      useCardDeepLink({
        tasks: [meta('from-push')],
        loading: false,
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

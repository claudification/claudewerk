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

/** A readTask that only answers for the lane the card is REALLY in. */
function fakeReadTask(real: Record<string, ProjectTaskMeta['status']>) {
  return vi.fn(async (slug: string, status: ProjectTaskMeta['status']) =>
    real[slug] === status ? ({ ...meta(slug, status), body: 'body' } as ProjectTask) : null,
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
    ask('fix-thing') // no lane hint, nothing loaded -- must WAIT, not drop
    expect(opened).toHaveLength(0)

    view.rerender(<Probe tasks={[meta('fix-thing', 'in-progress')]} loading={false} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].slug).toBe('fix-thing')
  })

  it('uses the lane hint while the manifest is still loading', async () => {
    const readTask = fakeReadTask({ quick: 'open' })
    const { opened, Probe, ask } = harness(readTask)
    render(<Probe tasks={[]} loading={true} />)
    ask('quick', 'open')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledWith('quick', 'open')
  })

  it('recovers when the lane hint is stale (the card moved)', async () => {
    // The link says `open`; the card is really in `done`.
    const readTask = fakeReadTask({ moved: 'done' })
    const { opened, Probe, ask } = harness(readTask)
    const view = render(<Probe tasks={[]} loading={true} />)
    ask('moved', 'open')
    await waitFor(() => expect(readTask).toHaveBeenCalledWith('moved', 'open'))
    expect(opened).toHaveLength(0) // stale lane missed...

    view.rerender(<Probe tasks={[meta('moved', 'done')]} loading={false} />)
    await waitFor(() => expect(opened).toHaveLength(1)) // ...manifest corrects it
    expect(readTask).toHaveBeenCalledWith('moved', 'done')
  })

  it('prefers the manifest lane over the hint when both are known', async () => {
    const readTask = fakeReadTask({ card: 'archived' })
    const { opened, Probe, ask } = harness(readTask)
    render(<Probe tasks={[meta('card', 'archived')]} loading={false} />)
    ask('card', 'inbox')
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledTimes(1)
    expect(readTask).toHaveBeenCalledWith('card', 'archived')
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

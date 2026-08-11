import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCardDeepLink } from './use-card-deeplink'
import { usePendingCard } from './use-kanban-modal'
import type { ProjectTask, ProjectTaskMeta } from './use-project'

const PROJECT = 'claude://default/Users/x/proj'
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

/** Mount the hook with a controllable tasks list. */
function harness() {
  const opened: ProjectTask[] = []
  const readTask = vi.fn(async (slug: string, status: ProjectTaskMeta['status']) => ({
    ...meta(slug, status),
    body: 'body',
  }))
  function Probe({ tasks, loading }: { tasks: ProjectTaskMeta[]; loading: boolean }) {
    useCardDeepLink({
      projectUri: PROJECT,
      tasks,
      loading,
      readTask,
      onOpen: t => {
        opened.push(t)
      },
    })
    return null
  }
  return { opened, readTask, Probe }
}

afterEach(cleanup)
beforeEach(() => usePendingCard.getState().clear())

describe('useCardDeepLink', () => {
  it('opens a parked card once the manifest lands (the mount race)', async () => {
    const { opened, Probe } = harness()
    // The request is made BEFORE the board has any tasks -- this is the exact
    // ordering a markdown card link produces (open modal, then load).
    act(() => usePendingCard.getState().request(PROJECT, 'fix-thing'))
    const view = render(<Probe tasks={[]} loading={true} />)
    expect(opened).toHaveLength(0)

    view.rerender(<Probe tasks={[meta('fix-thing', 'in-progress')]} loading={false} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].slug).toBe('fix-thing')
    // Claimed exactly once -- the park is cleared so it cannot re-fire.
    expect(usePendingCard.getState().pending).toBeNull()
  })

  it('resolves by slug even when the link named a stale lane', async () => {
    const { opened, readTask, Probe } = harness()
    const view = render(<Probe tasks={[]} loading={true} />)
    act(() => usePendingCard.getState().request(PROJECT, 'moved'))
    view.rerender(<Probe tasks={[meta('moved', 'done')]} loading={false} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(readTask).toHaveBeenCalledWith('moved', 'done')
  })

  it('ignores a request parked for another project', () => {
    const { opened, Probe } = harness()
    act(() => usePendingCard.getState().request('claude://default/Users/x/other', 'fix-thing'))
    render(<Probe tasks={[meta('fix-thing')]} loading={false} />)
    expect(opened).toHaveLength(0)
    expect(usePendingCard.getState().pending).not.toBeNull()
  })

  it('drops a request for a card the loaded board does not have', () => {
    const { opened, Probe } = harness()
    act(() => usePendingCard.getState().request(PROJECT, 'deleted'))
    render(<Probe tasks={[meta('something-else')]} loading={false} />)
    expect(opened).toHaveLength(0)
  })

  it('still honours the open-project-task event (push notification / hash route)', async () => {
    const { opened, Probe } = harness()
    render(<Probe tasks={[meta('from-push')]} loading={false} />)
    act(() => {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: 'from-push' } }))
    })
    await waitFor(() => expect(opened).toHaveLength(1))
  })
})

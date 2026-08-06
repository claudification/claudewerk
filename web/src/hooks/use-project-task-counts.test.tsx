import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from './use-conversations'
import { useProjectTaskCounts } from './use-project-task-counts'
import { useProjectTasks } from './use-project-tasks'

// The task cache is module-global and outlives a test, so each test uses its own
// project URI -- otherwise test N reads test N-1's cache and proves nothing.
let projectSeq = 0
const nextProject = () => `claude://default/Users/x/proj-${++projectSeq}`

let sent: Array<Record<string, unknown>> = []

/** A fake wire that answers a manifest request and records everything sent --
 *  including anything that would arm a sentinel watch. */
function installFakeWire() {
  sent = []
  useConversationsStore.setState({
    conversations: [],
    conversationsById: {},
    sendWsMessage: (msg: Record<string, unknown>) => {
      sent.push(msg)
      if (msg.type !== 'project_board_request' || msg.op !== 'manifest') return
      const reply = {
        type: 'project_board_result',
        requestId: msg.requestId,
        manifest: [
          { slug: 'a', status: 'open', mtime: 2 },
          { slug: 'b', status: 'open', mtime: 1 },
          { slug: 'c', status: 'in-progress', mtime: 3 },
          { slug: 'd', status: 'in-review', mtime: 4 },
        ],
      }
      queueMicrotask(() => useConversationsStore.getState().projectHandler?.(reply))
    },
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

function Counts({ project }: { project: string }) {
  const counts = useProjectTaskCounts(project)
  return <div data-testid="counts">{`${counts.open}/${counts['in-progress']}/${counts['in-review']}`}</div>
}

function Board({ project }: { project: string }) {
  useProjectTasks(project)
  return null
}

afterEach(cleanup)

describe('useProjectTaskCounts', () => {
  beforeEach(installFakeWire)

  it('counts the board by status', async () => {
    const { getByTestId } = render(<Counts project={nextProject()} />)
    await waitFor(() => expect(getByTestId('counts').textContent).toBe('2/1/1'))
  })

  it('ARMS NO SENTINEL WATCH -- hovering a project list must not open one per row', async () => {
    const { getByTestId, unmount } = render(<Counts project={nextProject()} />)
    await waitFor(() => expect(getByTestId('counts').textContent).toBe('2/1/1'))
    unmount()
    expect(sent.some(m => m.type === 'project_subscribe')).toBe(false)
    expect(sent.some(m => m.type === 'project_unsubscribe')).toBe(false)
    // It still got its data -- watch-free is not the same as fetch-free.
    expect(sent.some(m => m.type === 'project_board_request' && m.op === 'manifest')).toBe(true)
  })

  it('a mounted BOARD still arms the watch -- that is the surface that earns one', () => {
    const { unmount } = render(<Board project={nextProject()} />)
    expect(sent.some(m => m.type === 'project_subscribe')).toBe(true)
    unmount()
    expect(sent.some(m => m.type === 'project_unsubscribe')).toBe(true)
  })

  it('never triggers a SOTU scan or distill from a hover', async () => {
    const { getByTestId } = render(<Counts project={nextProject()} />)
    await waitFor(() => expect(getByTestId('counts').textContent).toBe('2/1/1'))
    expect(sent.some(m => typeof m.type === 'string' && (m.type as string).startsWith('sotu_'))).toBe(false)
  })

  it('serves a second hover from cache instead of refetching inside the TTL', async () => {
    const project = nextProject()
    const { getByTestId, unmount } = render(<Counts project={project} />)
    await waitFor(() => expect(getByTestId('counts').textContent).toBe('2/1/1'))
    unmount()
    const before = sent.filter(m => m.type === 'project_board_request').length
    const second = render(<Counts project={project} />)
    await waitFor(() => expect(second.getByTestId('counts').textContent).toBe('2/1/1'))
    expect(sent.filter(m => m.type === 'project_board_request').length).toBe(before)
  })
})

// A fetch is not part of this hook's contract, but a mistake here would be a
// per-hover HTTP call to the broker -- assert the global stays untouched.
it('touches no HTTP', async () => {
  installFakeWire()
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  render(<Counts project={nextProject()} />)
  await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled())
  cleanup()
  fetchSpy.mockRestore()
})

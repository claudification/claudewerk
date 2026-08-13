/**
 * REGRESSION: the Launch HANDOFF, not either dialog alone.
 *
 * Launch closes the card editor and opens the run dialog in the same commit.
 * Both are Radix modal dialogs, so the outgoing one's cleanup and the incoming
 * one's mount race: the symptom is a button that visibly does nothing.
 *
 * This drives the real sequence -- render editor, click Launch, assert the run
 * dialog is on screen and the page is still interactive.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask } from '@/hooks/use-project'

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign(
    (sel: (s: unknown) => unknown) =>
      sel({ conversationsById: { 'conv-1': { project: 'claude://s/CLAUDEWERK' } }, selectedConversationId: 'conv-1' }),
    {
      getState: () => ({
        conversationsById: { 'conv-1': { project: 'claude://s/CLAUDEWERK' } },
        selectedConversationId: 'conv-1',
      }),
    },
  ),
  sendInput: vi.fn(),
  useConversations: () => [],
}))

vi.mock('@/hooks/use-launch-progress', () => ({
  useLaunchProgress: () => ({
    steps: [],
    setSteps: vi.fn(),
    start: vi.fn(),
    isConnected: false,
    isComplete: false,
    hasError: false,
    elapsed: 0,
    error: null,
    spawnedConversation: null,
    launch: { conversationId: null, events: [], completed: false, failed: false, error: null },
    copyToClipboard: vi.fn(),
  }),
}))

afterEach(cleanup)

function task(): ProjectTask {
  return {
    slug: 'anvil-code-block',
    status: 'open',
    title: 'ANVIL @code block',
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    body: 'body text',
    bodyPreview: 'body text',
  }
}

/** The exact shape both real mount points use. */
function Harness({ TaskEditor, RunTaskDialog }: { TaskEditor: never; RunTaskDialog: never }) {
  const [editing, setEditing] = useState<ProjectTask | null>(task())
  const [running, setRunning] = useState<ProjectTask | null>(null)
  const Editor = TaskEditor as unknown as React.ComponentType<Record<string, unknown>>
  const Runner = RunTaskDialog as unknown as React.ComponentType<Record<string, unknown>>
  return (
    <>
      {editing && (
        <Editor
          task={editing}
          conversationId="conv-1"
          onSave={vi.fn()}
          onMove={vi.fn()}
          onRun={(t: ProjectTask) => {
            setEditing(null)
            setRunning(t)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {running && <Runner task={running} conversationId="conv-1" onClose={() => setRunning(null)} />}
    </>
  )
}

test('Launch closes the editor and opens the run dialog', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))

  await waitFor(() => {
    expect(screen.getByText('Run Task')).toBeTruthy()
  })
})

test('the run dialog names the task it is about to launch', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Run Task')).toBeTruthy())
  expect(screen.getAllByText('ANVIL @code block').length).toBeGreaterThan(0)
})

test('the editor is gone once the run dialog is up', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Run Task')).toBeTruthy())
  expect(screen.queryByRole('button', { name: /Work on this/i })).toBeNull()
})

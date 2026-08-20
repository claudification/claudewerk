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

// The editor now shows the card's epic at the top, which reads the project
// cache. These tests are about the LAUNCH handoff, so the board is empty and
// the strip renders nothing -- but the hook still has to exist.
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: [], readTask: async () => null }),
}))

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
  // A `vi.mock` factory REPLACES the module wholesale, so every symbol the
  // component tree reaches for has to be here or the import throws before a
  // single test body runs. These two arrived with the launch/kanban wiring and
  // were never added; the shiki resolution error masked them.
  findBestConversationForProject: () => undefined,
  wsSend: vi.fn(() => true),
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
    expect(screen.getByText('Work Card')).toBeTruthy()
  })
})

test('the run dialog names the task it is about to launch', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Work Card')).toBeTruthy())
  expect(screen.getAllByText('ANVIL @code block').length).toBeGreaterThan(0)
})

test('the editor is gone once the run dialog is up', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Work Card')).toBeTruthy())
  expect(screen.queryByRole('button', { name: /Work on this/i })).toBeNull()
})

test('the run dialog offers refine and analyze, not just work', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Work Card')).toBeTruthy())

  for (const label of ['Work', 'Refine', 'Analyze']) {
    expect(screen.getByRole('radio', { name: label })).toBeTruthy()
  }
})

// The failure this pins: picking ANALYZE and getting a dialog that still says
// "Work", so you cannot tell which prompt you are about to send.
test('picking a mode retitles the dialog and the run button', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Work Card')).toBeTruthy())

  fireEvent.click(screen.getByRole('radio', { name: 'Analyze' }))
  await waitFor(() => expect(screen.getByText('Analyze Card')).toBeTruthy())
  expect(screen.getByRole('radio', { name: 'Analyze' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByText('Work Card')).toBeNull()
})

test('the read-only modes say out loud that they will not move the card', async () => {
  const mod = await import('../project-board')
  render(<Harness TaskEditor={mod.TaskEditor as never} RunTaskDialog={mod.RunTaskDialog as never} />)

  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await waitFor(() => expect(screen.getByText('Work Card')).toBeTruthy())

  fireEvent.click(screen.getByRole('radio', { name: 'Refine' }))
  await waitFor(() => expect(screen.getByText(/does not implement it/)).toBeTruthy())

  fireEvent.click(screen.getByRole('radio', { name: 'Analyze' }))
  await waitFor(() => expect(screen.getByText(/changes nothing on disk/)).toBeTruthy())

  // Work is the one mode that DOES move it -- no disclaimer.
  fireEvent.click(screen.getByRole('radio', { name: 'Work' }))
  await waitFor(() => expect(screen.queryByText(/status unchanged/)).toBeNull())
})

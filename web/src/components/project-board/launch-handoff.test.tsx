/**
 * REGRESSION: the Launch HANDOFF, not either dialog alone.
 *
 * Launch closes the card editor and opens the run dialog in the same commit.
 * Both are Radix modal dialogs, so the outgoing one's cleanup and the incoming
 * one's mount race: the symptom is a button that visibly does nothing.
 *
 * This drives the real sequence -- render editor, click Launch, assert the run
 * dialog is on screen and the page is still interactive.
 *
 * NOTHING HERE MEASURES WALL-CLOCK TIME, on purpose. Every test body used to
 * open with `await import('../project-board')`, which put a Vite transform of
 * the WHOLE board orchestrator inside vitest's 5000ms per-test budget. Measured
 * on `studio`: idle, that import is 1223ms of a 1425ms first test -- 86% of it;
 * with ten cores pinned it is 3732ms of 4130ms, and the full 405-file suite
 * pushes it past 5000ms outright. The `waitFor` everyone suspected is 6ms idle
 * and 14ms saturated, 0.3% of the budget, and was never the problem.
 *
 * The failure is load-shaped rather than logic-shaped, which is why it looked
 * random: first test of the file always, ~1 full run in 28 with all ten cores
 * deliberately pinned, and never once when the file ran alone. When it goes it
 * takes two more with it -- a test that times out mid-render never tears its DOM
 * down, so the next one dies on `Found multiple elements with the text: Work
 * Card`. One starved test, three red lines.
 *
 * Two changes take the machine out of the assertion:
 *
 * 1. The components arrive by STATIC import at module scope. Module evaluation
 *    is not covered by any test timeout, so however slow the transform gets it
 *    is slow rather than red. And they come from their own files rather than
 *    through `../project-board`: this suite renders two dialogs and never the
 *    board, so pulling BoardHeader / BoardSurface / EpicsView and their hooks
 *    through the transform was pure cost. Measured under heavier load than the
 *    barrel run above, the direct route is 1865ms against 3732ms. The re-export
 *    in `project-board.tsx` stays covered by `task-editor-swap.test.tsx`, which
 *    reaches it through TaskEditorOverlay the way production does.
 *
 * 2. The settle is counted in REACT TURNS instead of milliseconds. `waitFor`'s
 *    1000ms is a bet on how busy the box is, and any such bet eventually loses;
 *    how many turns React needs to commit one state swap is a property of the
 *    component tree, and a loaded machine does not change it -- it only makes
 *    each turn take longer, which nothing below measures.
 *
 * NOT a raised timeout and not a skip. Both would buy headroom against the load
 * that happened to be measured and nothing against the next machine.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask } from '@/hooks/use-project'
import { RunTaskDialog } from './run-task-dialog'
import { TaskEditor } from './task-editor'

// The editor now shows the card's epic at the top, which reads the project
// cache. These tests are about the LAUNCH handoff, so the board is empty and
// the strip renders nothing -- but the hook still has to exist.
// A `vi.mock` factory REPLACES the module wholesale (see the note on the
// use-conversations mock below). `useProjectTasksList` is how the run dialog
// reads the board for the open-epic roster it hands a refine run.
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: [], readTask: async () => null }),
  useProjectTasksList: () => [],
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
function Harness() {
  const [editing, setEditing] = useState<ProjectTask | null>(task())
  const [running, setRunning] = useState<ProjectTask | null>(null)
  return (
    <>
      {editing && (
        <TaskEditor
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
      {running && <RunTaskDialog task={running} conversationId="conv-1" onClose={() => setRunning(null)} />}
    </>
  )
}

/**
 * Turn the crank until `seen()` holds -- counting REACT TURNS, not milliseconds.
 *
 * Measured post-hoist, every wait in this file lands in ONE turn. The bound is
 * fifty: far enough above one that no plausible restructuring of the handoff
 * reaches it, low enough that a dialog which never arrives fails in about a
 * second with a NAMED reason instead of hanging to the test timeout and taking
 * the next two tests down with it.
 *
 * A macrotask rather than a microtask, so anything the dialogs queued on a timer
 * gets its turn too.
 */
const HANDOFF_TURNS = 50

async function settleUntil(seen: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < HANDOFF_TURNS && !seen(); turn++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  expect(seen(), `${what} never settled in ${HANDOFF_TURNS} React turns`).toBe(true)
}

/** The handoff itself: click Launch, wait for the run dialog to be on screen. */
async function launchAndSettle(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Launch/i }))
  await settleUntil(() => screen.queryByText('Work Card') !== null, 'the run dialog')
}

test('Launch closes the editor and opens the run dialog', async () => {
  render(<Harness />)

  await launchAndSettle()
})

test('the run dialog names the task it is about to launch', async () => {
  render(<Harness />)

  await launchAndSettle()
  expect(screen.getAllByText('ANVIL @code block').length).toBeGreaterThan(0)
})

test('the editor is gone once the run dialog is up', async () => {
  render(<Harness />)

  await launchAndSettle()
  expect(screen.queryByRole('button', { name: /Work on this/i })).toBeNull()
})

test('the run dialog offers refine and analyze, not just work', async () => {
  render(<Harness />)

  await launchAndSettle()

  for (const label of ['Work', 'Refine', 'Analyze']) {
    expect(screen.getByRole('radio', { name: label })).toBeTruthy()
  }
})

// The failure this pins: picking ANALYZE and getting a dialog that still says
// "Work", so you cannot tell which prompt you are about to send.
test('picking a mode retitles the dialog and the run button', async () => {
  render(<Harness />)

  await launchAndSettle()

  fireEvent.click(screen.getByRole('radio', { name: 'Analyze' }))
  await settleUntil(() => screen.queryByText('Analyze Card') !== null, 'the Analyze retitle')
  expect(screen.getByRole('radio', { name: 'Analyze' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByText('Work Card')).toBeNull()
})

test('the read-only modes say out loud that they will not move the card', async () => {
  render(<Harness />)

  await launchAndSettle()

  fireEvent.click(screen.getByRole('radio', { name: 'Refine' }))
  await settleUntil(() => screen.queryByText(/does not implement it/) !== null, "Refine's disclaimer")

  fireEvent.click(screen.getByRole('radio', { name: 'Analyze' }))
  await settleUntil(() => screen.queryByText(/changes nothing on disk/) !== null, "Analyze's disclaimer")

  // Work is the one mode that DOES move it -- no disclaimer.
  fireEvent.click(screen.getByRole('radio', { name: 'Work' }))
  await settleUntil(() => screen.queryByText(/status unchanged/) === null, 'Work having no disclaimer')
})

/**
 * THE LAUNCH VERB IS ONE OF THE TWO NAMED CONSUMERS of a card's `model:` hint.
 *
 * A hint nothing reads is the "enabled, last ran never" failure again, so what
 * is pinned here is that the field ARRIVES seeded -- and that a card with no
 * hint still opens on the remembered default, because the hint may not quietly
 * retarget a launch nobody asked it to.
 */
test('a card carrying `model:` seeds the run dialog with it', async () => {
  render(<RunTaskDialog task={{ ...task(), model: 'opus' }} conversationId="conv-1" onClose={vi.fn()} />)

  await settleUntil(() => screen.queryByText('Work Card') !== null, 'the run dialog')
  expect(screen.getByLabelText('Model').textContent).toBe('Opus (latest)')
})

test('a card with no hint leaves the model field where it was', async () => {
  render(<RunTaskDialog task={task()} conversationId="conv-1" onClose={vi.fn()} />)

  await settleUntil(() => screen.queryByText('Work Card') !== null, 'the run dialog')
  expect(screen.getByLabelText('Model').textContent).toBe('Default')
})

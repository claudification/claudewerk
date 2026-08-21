/**
 * The modal's job is to make the invisible visible: which BOARD this lands on,
 * and which tokens were eaten. Both are silent-failure surfaces -- a wrong
 * project or a dropped chip looks exactly like a correct capture until the card
 * turns up somewhere unexpected.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { applyChip, emptyChips } from '@/lib/cards/task-chips'

const submit = vi.fn()
const submitRefine = vi.fn()
let state: Record<string, unknown> = {}

vi.mock('./use-quick-task', () => ({ useQuickTask: () => state }))
vi.mock('./wall/use-project-look', () => ({
  useProjectLook: () => (uri: string) => ({ projectName: uri === 'claude://s/yemaya' ? 'YEMAYA' : 'CLAUDEWERK' }),
}))
vi.mock('./input-editor', () => ({
  // The editor's key handling is CM6's (pinned in submit-keys.test.ts); what
  // this stub proves is the WIRING -- that Mod-Enter's callback is the refine
  // submit and not the plain one.
  InputEditor: ({ placeholder, onSubmitAlt }: { placeholder?: string; onSubmitAlt?: () => void }) => (
    <>
      <textarea placeholder={placeholder} readOnly />
      <button type="button" onClick={onSubmitAlt}>
        alt-submit
      </button>
    </>
  ),
}))

const { QuickTaskModal } = await import('./quick-task-modal')

function mount(over: Record<string, unknown> = {}) {
  state = {
    open: true,
    onOpenChange: () => {},
    text: 'capture',
    setText: () => {},
    chips: emptyChips(),
    onRemoveChip: () => {},
    taskTokens: {},
    submit,
    submitRefine,
    flash: false,
    targetProject: 'claude://s/here',
    retargeted: false,
    ...over,
  }
  return render(<QuickTaskModal />)
}

afterEach(() => {
  cleanup()
  submit.mockClear()
  submitRefine.mockClear()
})

test('names the board the capture will land on', () => {
  mount()
  expect(screen.getByText('CLAUDEWERK')).toBeTruthy()
})

test('a retargeted capture shows the NEW project, not the conversation one', () => {
  mount({ targetProject: 'claude://s/yemaya', retargeted: true })
  expect(screen.getByText('YEMAYA')).toBeTruthy()
})

test('with no project at all it says so and disables Add', () => {
  mount({ targetProject: null })
  expect(screen.getByText(/No project selected/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Add/ }).hasAttribute('disabled')).toBe(true)
})

test('accepted chips are rendered, so an eaten token is never invisible', () => {
  mount({ chips: applyChip(emptyChips(), 'epic', 'epic-the-wall-ii') })
  expect(screen.getByText('epic-the-wall-ii')).toBeTruthy()
})

test('empty text disables Add even with a project', () => {
  mount({ text: '   ' })
  expect(screen.getByRole('button', { name: /Add/ }).hasAttribute('disabled')).toBe(true)
})

test('Add fires submit when text and project are both present', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: /Add/ }))
  expect(submit).toHaveBeenCalledTimes(1)
})

test('the placeholder advertises every trigger', () => {
  mount()
  const ph = screen.getByRole('textbox').getAttribute('placeholder') ?? ''
  for (const t of ['/project', '@epic', '!priority', '+waits-on', '&see-also', '#tag']) {
    expect(ph).toContain(t)
  }
})

test("the editor's alternate submit is the REFINE one, never the plain one", () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'alt-submit' }))
  expect(submitRefine).toHaveBeenCalledTimes(1)
  expect(submit).not.toHaveBeenCalled()
})

test('the footer advertises every key path, refine included', () => {
  mount()
  // Radix portals the dialog, so read the document rather than the container.
  const footer = document.body.textContent ?? ''
  // A keybinding nobody can see is a keybinding nobody uses.
  for (const hint of ['add', 'newline', 'refine later', 'close']) {
    expect(footer).toContain(hint)
  }
})

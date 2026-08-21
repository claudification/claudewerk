/**
 * The behaviours a capture box gets wrong SILENTLY, so each one is pinned here:
 *   - the card lands on the project you targeted, not the one you were sitting in
 *   - an open epic pre-fills, and does not leak into the next capture
 *   - switching board drops the chips that only meant something on the old one
 *
 * Every failure mode above writes a plausible-looking card to the WRONG place,
 * which is the kind of bug you find weeks later on someone else's board.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const sendBoardOp = vi.fn(() => Promise.resolve({}))
let focusedEpic: string | null = null

vi.mock('@/hooks/use-project-tasks', () => ({ sendBoardOp: (...a: unknown[]) => sendBoardOp(...a) }))
vi.mock('@/hooks/use-project', () => ({ useProjectTasksList: () => [] }))
vi.mock('@/hooks/use-known-projects', () => ({
  useKnownProjects: () => [{ uri: 'claude://s/yemaya', name: 'YEMAYA', path: '/y' }],
}))
vi.mock('@/hooks/use-selected-conversation', () => ({
  useSelectedConversation: () => ({ selectedConversationId: 'c1', conversation: { project: 'claude://s/here' } }),
}))
vi.mock('@/lib/cards/epic-focus', () => ({ readEpicFocus: () => focusedEpic }))
vi.mock('@/lib/utils', () => ({ haptic: () => {} }))

const handlers: Array<(() => void) | null> = []
vi.mock('./quick-task-trigger', () => ({
  quickTaskBus: { setHandler: (h: (() => void) | null) => handlers.push(h) },
}))

const { useQuickTask } = await import('./use-quick-task')

/** Mount and fire the open path, the way Ctrl+Shift+N does. */
function open() {
  const hook = renderHook(() => useQuickTask())
  act(() => {
    handlers.filter(Boolean).at(-1)?.()
  })
  return hook
}

beforeEach(() => {
  sendBoardOp.mockClear()
  handlers.length = 0
  focusedEpic = null
})
afterEach(() => vi.clearAllMocks())

test('defaults to the selected conversation project', () => {
  const { result } = open()
  expect(result.current.targetProject).toBe('claude://s/here')
  expect(result.current.retargeted).toBe(false)
})

test('an open epic pre-fills the chip', () => {
  focusedEpic = 'epic-the-wall-ii'
  const { result } = open()
  expect(result.current.chips.epic).toBe('epic-the-wall-ii')
})

test('no focused epic means no chip -- never a stale one', () => {
  const { result } = open()
  expect(result.current.chips.epic).toBeUndefined()
})

test('/project retargets the board and flags the override', () => {
  const { result } = open()
  act(() => result.current.taskTokens.onPickProject('claude://s/yemaya'))
  expect(result.current.targetProject).toBe('claude://s/yemaya')
  expect(result.current.retargeted).toBe(true)
})

test('switching board drops card-scoped chips but keeps priority', () => {
  focusedEpic = 'epic-here'
  const { result } = open()
  act(() => result.current.taskTokens.onPick('priority', 'high'))
  act(() => result.current.taskTokens.onPick('dependsOn', 'card-on-old-board'))
  act(() => result.current.taskTokens.onPickProject('claude://s/yemaya'))

  expect(result.current.chips.epic).toBeUndefined()
  expect(result.current.chips.dependsOn).toEqual([])
  expect(result.current.chips.priority).toBe('high')
})

test('submit writes to the RETARGETED project, not the conversation one', () => {
  const { result } = open()
  act(() => result.current.setText('capture this'))
  act(() => result.current.taskTokens.onPickProject('claude://s/yemaya'))
  act(() => result.current.submit())

  expect(sendBoardOp).toHaveBeenCalledTimes(1)
  const [uri, op, params] = sendBoardOp.mock.calls[0] as [string, string, { input: Record<string, unknown> }]
  expect(uri).toBe('claude://s/yemaya')
  expect(op).toBe('create')
  expect(params.input.title).toBe('capture this')
})

test('submit carries the accepted chips onto the card', () => {
  focusedEpic = 'epic-the-wall-ii'
  const { result } = open()
  act(() => result.current.setText('do it #infra'))
  act(() => result.current.taskTokens.onPick('priority', 'high'))
  act(() => result.current.submit())

  const params = sendBoardOp.mock.calls[0][2] as { input: Record<string, unknown> }
  expect(params.input).toMatchObject({ epic: 'epic-the-wall-ii', priority: 'high', tags: ['infra'] })
  // Tag stripped from the title, kept in the body.
  expect(params.input.title).toBe('do it')
  expect(params.input.body).toBe('do it #infra')
})

test('an empty capture submits nothing', () => {
  const { result } = open()
  act(() => result.current.setText('   '))
  act(() => result.current.submit())
  expect(sendBoardOp).not.toHaveBeenCalled()
})

test('closing clears text, chips and the override', () => {
  const { result } = open()
  act(() => result.current.setText('draft'))
  act(() => result.current.taskTokens.onPickProject('claude://s/yemaya'))
  act(() => result.current.onOpenChange(false))

  expect(result.current.text).toBe('')
  expect(result.current.retargeted).toBe(false)
  expect(result.current.targetProject).toBe('claude://s/here')
})

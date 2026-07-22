import type { DialogLayout } from '@shared/dialog-schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const respondToAskQuestion = vi.fn()
const submitDialog = vi.fn()

let state: Record<string, unknown> = {}
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ ...state, respondToAskQuestion, submitDialog }) },
}))

const { runAnswerDialog } = await import('./answer-dialog')
const { setDialogAttempt } = await import('./dialog-attempt')

const ASK = {
  conversationId: 'c1',
  toolUseId: 'tu_1',
  questions: [
    {
      question: 'Ship it?',
      header: 'Ship',
      options: [{ label: 'Ship now' }, { label: 'Hold' }],
    },
  ],
}

const PICK_LAYOUT: DialogLayout = {
  title: 'Which way?',
  body: [
    {
      type: 'Options',
      id: 'choice',
      label: 'Which way?',
      options: [
        { value: 'forward', label: 'Roll forward' },
        { value: 'back', label: 'Roll back' },
      ],
    },
  ],
}

beforeEach(() => {
  respondToAskQuestion.mockClear()
  submitDialog.mockClear()
  setDialogAttempt(null)
  state = {
    selectedConversationId: 'c1',
    conversationsById: { c1: { title: 'station bar' }, c2: { title: 'arr sweep' } },
    pendingAskQuestions: [ASK],
    pendingDialogs: {},
  }
})

describe('answering a native ask', () => {
  it('submits the matched LABEL through the store action the banner uses', () => {
    const out = runAnswerDialog({ answer: 'hold', target: null })
    expect(respondToAskQuestion).toHaveBeenCalledWith('c1', 'tu_1', { 'Ship it?': 'Hold' })
    expect(out).toMatchObject({ answered: true, choice: 'Hold', conversation: 'station bar' })
  })

  it('takes a positional answer', () => {
    runAnswerDialog({ answer: 'the first one', target: null })
    expect(respondToAskQuestion).toHaveBeenCalledWith('c1', 'tu_1', { 'Ship it?': 'Ship now' })
  })
})

describe('answering a one-shot dialog', () => {
  beforeEach(() => {
    state.pendingAskQuestions = []
    state.pendingDialogs = { c1: { dialogId: 'd1', layout: PICK_LAYOUT, timestamp: 0 } }
  })

  it('submits the option VALUE in the exact result shape a click produces', () => {
    const out = runAnswerDialog({ answer: 'roll back', target: null })
    expect(submitDialog).toHaveBeenCalledWith('c1', 'd1', {
      choice: 'back',
      _action: 'submit',
      _timeout: false,
      _cancelled: false,
    })
    expect(out).toMatchObject({ answered: true, choice: 'Roll back' })
  })

  it('leaves an expired dialog to the panel', () => {
    state.pendingDialogs = { c1: { dialogId: 'd1', layout: PICK_LAYOUT, timestamp: 0, expired: true } }
    expect(runAnswerDialog({ answer: 'roll back' })).toMatchObject({
      error: expect.stringContaining('nothing is open'),
    })
    expect(submitDialog).not.toHaveBeenCalled()
  })
})

describe('submitting NOTHING', () => {
  it('hands the options back when the answer is not one of them', () => {
    const out = runAnswerDialog({ answer: 'burn it down', target: null })
    expect(respondToAskQuestion).not.toHaveBeenCalled()
    expect(out).toMatchObject({ submitted: false, question: 'Ship it?', options: ['Ship now', 'Hold'] })
  })

  it('refuses an empty answer instead of inventing one', () => {
    expect(runAnswerDialog({ answer: '   ' })).toMatchObject({ error: expect.stringContaining('no answer heard') })
    expect(respondToAskQuestion).not.toHaveBeenCalled()
  })

  it('refuses when nothing answerable is open', () => {
    state.pendingAskQuestions = []
    expect(runAnswerDialog({ answer: 'yes' })).toMatchObject({ error: expect.stringContaining('nothing is open') })
  })

  it('refuses when two conversations are asking and he did not say which', () => {
    state.pendingAskQuestions = [ASK, { ...ASK, conversationId: 'c2', toolUseId: 'tu_2' }]
    state.selectedConversationId = null
    const out = runAnswerDialog({ answer: 'hold' })
    expect(respondToAskQuestion).not.toHaveBeenCalled()
    expect(out).toMatchObject({ submitted: false, error: expect.stringContaining('more than one question') })
    expect((out.questions as unknown[]).length).toBe(2)
  })

  it('falls back to the question on the conversation he is looking at', () => {
    state.pendingAskQuestions = [ASK, { ...ASK, conversationId: 'c2', toolUseId: 'tu_2' }]
    state.selectedConversationId = 'c2'
    runAnswerDialog({ answer: 'hold' })
    expect(respondToAskQuestion).toHaveBeenCalledWith('c2', 'tu_2', { 'Ship it?': 'Hold' })
  })
})

describe('naming the conversation', () => {
  beforeEach(() => {
    state.pendingAskQuestions = [ASK, { ...ASK, conversationId: 'c2', toolUseId: 'tu_2' }]
  })

  it('answers the one he named', () => {
    runAnswerDialog({ answer: 'hold', target: 'arr sweep' })
    expect(respondToAskQuestion).toHaveBeenCalledWith('c2', 'tu_2', { 'Ship it?': 'Hold' })
  })

  it('sends nothing when the name matches none of the ones asking', () => {
    const out = runAnswerDialog({ answer: 'hold', target: 'some other thing' })
    expect(respondToAskQuestion).not.toHaveBeenCalled()
    expect(out).toMatchObject({ submitted: false })
  })
})

describe('the cancel rule', () => {
  it('answers the question the orb actually read out, not whatever else is open', () => {
    state.pendingAskQuestions = [ASK, { ...ASK, conversationId: 'c2', toolUseId: 'tu_2' }]
    state.selectedConversationId = 'c1'
    setDialogAttempt({ key: 'tu_2', conversationId: 'c2' })
    runAnswerDialog({ answer: 'hold' })
    expect(respondToAskQuestion).toHaveBeenCalledWith('c2', 'tu_2', { 'Ship it?': 'Hold' })
  })

  it('refuses a late answer once that question was answered on screen', () => {
    // The orb read out tu_2; he clicked it in the panel; another is still open.
    setDialogAttempt({ key: 'tu_2', conversationId: 'c2' })
    const out = runAnswerDialog({ answer: 'hold' })
    expect(respondToAskQuestion).not.toHaveBeenCalled()
    expect(out).toMatchObject({ submitted: false, error: expect.stringContaining('already answered on screen') })
  })

  it('spends the attempt on a successful answer, so it cannot be replayed', () => {
    setDialogAttempt({ key: 'tu_1', conversationId: 'c1' })
    runAnswerDialog({ answer: 'hold' })
    expect(respondToAskQuestion).toHaveBeenCalledTimes(1)
    // The panel would have dropped it; simulate that and try again.
    state.pendingAskQuestions = []
    expect(runAnswerDialog({ answer: 'hold' })).toMatchObject({ error: expect.stringContaining('nothing is open') })
    expect(respondToAskQuestion).toHaveBeenCalledTimes(1)
  })
})

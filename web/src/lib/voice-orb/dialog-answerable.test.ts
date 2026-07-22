import type { DialogComponent, DialogLayout } from '@shared/dialog-schema'
import { describe, expect, it } from 'vitest'
import { answerableDialogs, askAnswerable, dialogAnswerable, type PendingAsk } from './dialog-answerable'

const ask = (over: Partial<PendingAsk['questions'][number]> = {}, count = 1): PendingAsk => ({
  conversationId: 'c1',
  toolUseId: 'tu_1',
  questions: Array.from({ length: count }, (_, i) => ({
    question: count > 1 ? `question ${i + 1}` : 'Ship it?',
    header: 'Ship',
    options: [
      { label: 'Ship now', description: 'deploy' },
      { label: 'Hold', description: 'wait' },
    ],
    ...over,
  })),
})

const layout = (body: DialogComponent[], over: Partial<DialogLayout> = {}): DialogLayout => ({
  title: 'Pick one',
  body,
  ...over,
})

const options = (over: Partial<Extract<DialogComponent, { type: 'Options' }>> = {}): DialogComponent => ({
  type: 'Options',
  id: 'choice',
  label: 'Which way?',
  options: [
    { value: 'a', label: 'Roll forward' },
    { value: 'b', label: 'Roll back' },
  ],
  ...over,
})

describe('a native ask', () => {
  it('normalises a single-choice question into one descriptor', () => {
    const out = askAnswerable(ask())
    expect(out).toMatchObject({
      kind: 'ask',
      conversationId: 'c1',
      key: 'tu_1',
      fieldId: 'Ship it?',
      question: 'Ship it?',
    })
    // An ask has no separate value -- the label IS what gets submitted.
    expect(out?.options).toEqual([
      { value: 'Ship now', label: 'Ship now', description: 'deploy' },
      { value: 'Hold', label: 'Hold', description: 'wait' },
    ])
  })

  it('refuses a multi-question ask -- one spoken answer would submit a half-answer', () => {
    expect(askAnswerable(ask({}, 3))).toBeNull()
  })

  it('refuses multi-select: "A and C" is a sentence, not a selection', () => {
    expect(askAnswerable(ask({ multiSelect: true }))).toBeNull()
  })

  it('refuses a question with no options to speak', () => {
    expect(askAnswerable(ask({ options: [] }))).toBeNull()
  })
})

describe('a one-shot dialog', () => {
  const pending = (l: DialogLayout, expired?: boolean) => ({
    conversationId: 'c2',
    dialogId: 'd1',
    layout: l,
    expired,
  })

  it('takes a modal whose whole content is one pick-one list', () => {
    const out = dialogAnswerable(pending(layout([{ type: 'Markdown', content: 'context' }, options()])))
    expect(out).toMatchObject({ kind: 'dialog', key: 'd1', fieldId: 'choice', question: 'Which way?' })
    expect(out?.options.map(o => o.value)).toEqual(['a', 'b'])
  })

  it('finds the options block nested inside containers', () => {
    const nested: DialogComponent = { type: 'Stack', id: 's', children: [options()] }
    expect(dialogAnswerable(pending(layout([nested])))?.fieldId).toBe('choice')
  })

  it('refuses when there is a SECOND thing to fill in', () => {
    const withText: DialogComponent = { type: 'TextInput', id: 'why', label: 'Why?' }
    expect(dialogAnswerable(pending(layout([options(), withText])))).toBeNull()
  })

  it('ignores buttons -- they record an action, they are not a value', () => {
    const button: DialogComponent = { type: 'Button', id: 'go', label: 'Go' }
    expect(dialogAnswerable(pending(layout([options(), button])))).not.toBeNull()
  })

  it('refuses multi-select, multi-page wizards, and expired dialogs', () => {
    expect(dialogAnswerable(pending(layout([options({ multi: true })])))).toBeNull()
    const paged = layout([], {
      body: undefined,
      pages: [
        { label: 'one', body: [options()] },
        { label: 'two', body: [] },
      ],
    })
    expect(dialogAnswerable(pending(paged))).toBeNull()
    expect(dialogAnswerable(pending(layout([options()]), true))).toBeNull()
  })

  it('bars a plan approval by SOURCE -- nothing spoken exits plan mode', () => {
    const planish = { ...pending(layout([options()])), source: 'plan_approval' }
    expect(dialogAnswerable(planish)).toBeNull()
    // ...and an ordinary MCP dialog is unaffected.
    expect(dialogAnswerable({ ...pending(layout([options()])), source: 'mcp' })).not.toBeNull()
  })

  it('refuses a dialog with nothing to answer at all', () => {
    expect(dialogAnswerable(pending(layout([{ type: 'Markdown', content: 'just words' }])))).toBeNull()
  })

  it('falls back to the layout title when the options block has no label', () => {
    const out = dialogAnswerable(pending(layout([options({ label: undefined })], { description: 'the ask' })))
    expect(out?.question).toBe('the ask')
  })
})

describe('everything open at once', () => {
  it('lists asks before dialogs and drops what voice cannot answer', () => {
    const out = answerableDialogs(
      [ask(), ask({}, 2)],
      [
        { conversationId: 'c2', dialogId: 'd1', layout: layout([options()]) },
        { conversationId: 'c3', dialogId: 'd2', layout: layout([{ type: 'TextInput', id: 't' }]) },
      ],
    )
    expect(out.map(d => d.key)).toEqual(['tu_1', 'd1'])
  })
})

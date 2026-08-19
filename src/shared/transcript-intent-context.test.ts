import { describe, expect, test } from 'bun:test'
import { buildIntentContext, conversationShape, extractText } from './transcript-intent-context'

const line = (msg: unknown) => JSON.stringify({ message: msg })

describe('extractText', () => {
  test('pulls the human text out of a user turn', () => {
    const out = extractText(line({ role: 'user', content: [{ type: 'text', text: '  fix the spawn timeout  ' }] }))
    expect(out).toEqual({ user: 'fix the spawn timeout' })
  })

  // A tool_result-only user turn is plumbing. Counting it as a user message
  // would misread the conversation's shape and pad the intent context.
  test('ignores a tool_result-only user turn', () => {
    expect(extractText(line({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }))).toEqual({})
  })

  test('lifts the Bash description -- the free tier-2 label', () => {
    const out = extractText(
      line({
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Run the tests' } }],
      }),
    )
    expect(out).toEqual({ activity: '[Bash] Run the tests' })
  })

  test('falls back to the bare tool name when there is no description', () => {
    const out = extractText(line({ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] }))
    expect(out).toEqual({ activity: '[Read]' })
  })

  test('joins mixed assistant parts in order', () => {
    const out = extractText(
      line({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking that.' },
          { type: 'tool_use', name: 'Bash', input: { description: 'List files' } },
        ],
      }),
    )
    expect(out).toEqual({ activity: 'Checking that. | [Bash] List files' })
  })

  // A classify pass must never die on one bad row.
  test('survives malformed and unknown input', () => {
    expect(extractText('not json')).toEqual({})
    expect(extractText('{}')).toEqual({})
    expect(extractText(line({ role: 'system', content: [] }))).toEqual({})
    expect(extractText(line({ role: 'user', content: 'a bare string' }))).toEqual({})
  })
})

describe('buildIntentContext', () => {
  const userLine = (text: string, atMs: number) => ({
    content: line({ role: 'user', content: [{ type: 'text', text }] }),
    atMs,
  })

  test('keeps user messages oldest-first with their clocks', () => {
    const ctx = buildIntentContext([userLine('first ask', 10), userLine('later redirect', 20)])
    expect(ctx.userMessages).toEqual([
      { text: 'first ask', atMs: 10 },
      { text: 'later redirect', atMs: 20 },
    ])
  })

  // The harness talking, not the human. Counting these would flip a `new`
  // conversation to `long` and pad the context with text nobody asked for.
  test('drops injected system-reminder turns', () => {
    const ctx = buildIntentContext([userLine('<system-reminder>do a thing</system-reminder>', 1), userLine('real', 2)])
    expect(ctx.userMessages).toEqual([{ text: 'real', atMs: 2 }])
  })

  // Found by benchmarking: real conversations were naming themselves after our
  // own stop-hook text, because hook output arrives on a user turn.
  test('drops hook feedback injected as a user turn', () => {
    const hook = 'Stop hook feedback: You did real work this turn but never called set_status.'
    const ctx = buildIntentContext([userLine(hook, 1), userLine('fix the spawn timeout', 2)])
    expect(ctx.userMessages).toEqual([{ text: 'fix the spawn timeout', atMs: 2 }])
  })

  test('drops image placeholders and continuation banners', () => {
    const ctx = buildIntentContext([
      userLine('[Image: original 2308x1972, displayed at 2000x1709.]', 1),
      userLine('This session is being continued from a previous conversation', 2),
      userLine('real ask', 3),
    ])
    expect(ctx.userMessages).toEqual([{ text: 'real ask', atMs: 3 }])
  })

  // A human quoting a hook is still the human -- only a LEADING match counts.
  test('keeps a human message that merely mentions a hook', () => {
    const ctx = buildIntentContext([userLine('why does the stop hook feedback keep firing?', 1)])
    expect(ctx.userMessages).toHaveLength(1)
  })

  test('bounds the activity tail to the most recent entries', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      content: line({ role: 'assistant', content: [{ type: 'tool_use', name: `T${i}`, input: {} }] }),
      atMs: i,
    }))
    const ctx = buildIntentContext(lines, 5)
    expect(ctx.activity).toEqual(['[T35]', '[T36]', '[T37]', '[T38]', '[T39]'])
  })

  test('an empty transcript yields empty context, not a throw', () => {
    expect(buildIntentContext([])).toEqual({ userMessages: [], activity: [] })
  })
})

describe('conversationShape', () => {
  const ctx = (n: number) => ({
    userMessages: Array.from({ length: n }, (_, i) => ({ text: `m${i}`, atMs: i })),
    activity: [],
  })

  test('new is one or two user messages -- nothing to summarize but the ask', () => {
    expect(conversationShape(ctx(1))).toBe('new')
    expect(conversationShape(ctx(2))).toBe('new')
  })

  test('long needs a real back-and-forth', () => {
    expect(conversationShape(ctx(3))).toBe('long')
    expect(conversationShape(ctx(20))).toBe('long')
  })
})

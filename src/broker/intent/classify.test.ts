import { describe, expect, test } from 'bun:test'
import type { IntentContext } from '../../shared/transcript-intent-context'
import { classifyConversation, parseIntent } from './classify'
import { intentSystemPrompt, intentUserPrompt } from './prompt'

const ctx = (userMessages: Array<{ text: string; atMs: number }>, activity: string[] = []): IntentContext => ({
  userMessages,
  activity,
})

describe('parseIntent', () => {
  test('reads a clean JSON reply', () => {
    const out = parseIntent('{"name":"spawn timeout fix","title":"Fix spawn timeout","description":"d","intent":"i"}')
    expect(out).toEqual({ name: 'spawn timeout fix', title: 'Fix spawn timeout', description: 'd', intent: 'i' })
  })

  // Models obey "ONLY JSON" most of the time. The rest must not crash a run.
  test('survives fences and prose around the object', () => {
    const out = parseIntent('Sure!\n```json\n{"name":"a","title":"b"}\n```\nHope that helps.')
    expect(out).toMatchObject({ name: 'a', title: 'b' })
  })

  test('defaults the optional fields rather than dropping the answer', () => {
    expect(parseIntent('{"name":"a","title":"b"}')).toEqual({ name: 'a', title: 'b', description: '', intent: '' })
  })

  test('returns null when there is no usable answer', () => {
    expect(parseIntent('no json here')).toBeNull()
    expect(parseIntent('{"description":"only prose"}')).toBeNull()
    expect(parseIntent('{broken')).toBeNull()
    expect(parseIntent('')).toBeNull()
  })

  test('trims whitespace the model leaves in', () => {
    expect(parseIntent('{"name":"  a  ","title":" b "}')).toMatchObject({ name: 'a', title: 'b' })
  })
})

describe('intentUserPrompt', () => {
  test('labels the opening ask as the INITIAL REQUEST', () => {
    const p = intentUserPrompt(ctx([{ text: 'fix the spawn timeout', atMs: 1 }]))
    expect(p).toContain('INITIAL REQUEST:\nfix the spawn timeout')
  })

  // A new conversation must not look like it has progress -- that is what makes
  // a model invent some.
  test('says plainly that nothing has happened yet', () => {
    const p = intentUserPrompt(ctx([{ text: 'start this', atMs: 1 }]))
    expect(p).toContain('(nothing yet -- no work has started)')
  })

  // Time decay: the newest message is the likeliest redirect, so it must survive
  // truncation. Newest-first ordering is what guarantees that.
  test('lists later user inputs newest first', () => {
    const p = intentUserPrompt(
      ctx([
        { text: 'original ask', atMs: 1 },
        { text: 'middle', atMs: 2 },
        { text: 'actually do this instead', atMs: 3 },
      ]),
    )
    const since = p.slice(p.indexOf('USER INPUTS SINCE'))
    expect(since.indexOf('actually do this instead')).toBeLessThan(since.indexOf('middle'))
    expect(p).toContain('INITIAL REQUEST:\noriginal ask')
  })

  test('includes results when there are some', () => {
    const p = intentUserPrompt(ctx([{ text: 'go', atMs: 1 }], ['[Bash] Run the tests']))
    expect(p).toContain('RESULTS SO FAR:\n- [Bash] Run the tests')
  })

  test('omits the USER INPUTS SINCE block for a single-message conversation', () => {
    expect(intentUserPrompt(ctx([{ text: 'only ask', atMs: 1 }]))).not.toContain('USER INPUTS SINCE')
  })
})

describe('intentSystemPrompt', () => {
  test('the new-conversation prompt forbids inventing progress', () => {
    const p = intentSystemPrompt('new')
    expect(p).toContain('no work has happened yet')
    expect(p).toMatch(/do not describe progress/i)
  })

  test('the long-conversation prompt fights tail bias and mission staleness', () => {
    const p = intentSystemPrompt('long')
    expect(p).toMatch(/MAIN TASK, not the latest exchange/)
    expect(p).toMatch(/SUPERSEDE/)
  })

  test('both carry the 30-char git-commit-subject calibration', () => {
    for (const shape of ['new', 'long'] as const) {
      expect(intentSystemPrompt(shape)).toContain('git-commit-subject, not sentence')
    }
  })
})

describe('classifyConversation', () => {
  const reply = (content: string) => async () => ({ content, raw: {}, usage: { costUsd: 0 }, model: 'm' }) as never

  test('returns the parsed intent and tags the spend', async () => {
    let seen: { feature?: string; model?: string } = {}
    const out = await classifyConversation(ctx([{ text: 'go', atMs: 1 }]), async req => {
      seen = { feature: req.feature, model: req.model }
      return { content: '{"name":"a","title":"b"}', raw: {}, usage: { costUsd: 0 }, model: 'm' } as never
    })
    expect(out).toMatchObject({ name: 'a', title: 'b' })
    // Every OpenRouter call must be attributable in the spend log.
    expect(seen.feature).toBe('classify-intent')
  })

  test('picks the shape-specific system prompt from the context', async () => {
    let system = ''
    const capture = async (req: { system?: string }) => {
      system = req.system ?? ''
      return { content: '{"name":"a","title":"b"}', raw: {}, usage: { costUsd: 0 }, model: 'm' } as never
    }
    await classifyConversation(ctx([{ text: 'one', atMs: 1 }]), capture as never)
    expect(system).toContain('no work has happened yet')

    await classifyConversation(
      ctx([
        { text: 'a', atMs: 1 },
        { text: 'b', atMs: 2 },
        { text: 'c', atMs: 3 },
      ]),
      capture as never,
    )
    expect(system).toContain('MAIN TASK, not the latest exchange')
  })

  test('returns null on an unusable reply rather than throwing', async () => {
    expect(await classifyConversation(ctx([{ text: 'go', atMs: 1 }]), reply('garbage') as never)).toBeNull()
  })
})

/**
 * generateForkSummary -- fork mode C.
 *
 * The chat call is injected, so these pin the parts that are ours: what gets
 * fed to the model, the refusal on an empty transcript (a summary invented from
 * nothing is worse than an error), and the framing of the seed prompt.
 */
import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { buildForkSeedPrompt, generateForkSummary, renderTurns } from './fork-summary'

function userEntry(text: string, ts = 1): TranscriptEntry {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}

function assistantEntry(text: string, ts = 2): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}

const TRANSCRIPT = [
  userEntry('fix the slug bug', 1),
  assistantEntry('Fixed it in transcript-path.ts.', 2),
  userEntry('now add a test', 3),
  assistantEntry('Added a regression test.', 4),
]

function fakeChat(content: string) {
  return (async () => ({ content })) as never
}

describe('renderTurns', () => {
  test('renders user and assistant turns', () => {
    const out = renderTurns(TRANSCRIPT)
    expect(out).toContain('USER: fix the slug bug')
    expect(out).toContain('ASSISTANT: Fixed it in transcript-path.ts.')
    expect(out).toContain('USER: now add a test')
  })

  test('empty transcript renders nothing', () => {
    expect(renderTurns([]).trim()).toBe('')
  })
})

describe('generateForkSummary', () => {
  test('returns the summary the model produced', async () => {
    const r = await generateForkSummary({ entries: TRANSCRIPT, chatFn: fakeChat('GOAL -- fix the slug.') })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    expect(r.summary).toBe('GOAL -- fix the slug.')
  })

  test('refuses an empty transcript rather than inventing one', async () => {
    const r = await generateForkSummary({ entries: [], chatFn: fakeChat('I made this up') })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.error).toContain('Nothing to summarize')
  })

  test('treats an empty model response as a failure', async () => {
    const r = await generateForkSummary({ entries: TRANSCRIPT, chatFn: fakeChat('   ') })
    expect(r.ok).toBe(false)
  })

  test('surfaces the model error instead of throwing', async () => {
    const boom = (async () => {
      throw new Error('rate limited')
    }) as never
    const r = await generateForkSummary({ entries: TRANSCRIPT, chatFn: boom })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.error).toContain('rate limited')
  })

  test('feeds the session title in as context when present', async () => {
    let seenUser = ''
    const spy = (async (req: { user?: string }) => {
      seenUser = req.user ?? ''
      return { content: 'ok' }
    }) as never
    await generateForkSummary({ entries: TRANSCRIPT, conversationTitle: 'Slug hunt', chatFn: spy })
    expect(seenUser).toContain('Session: Slug hunt')
    expect(seenUser).toContain('fix the slug bug')
  })
})

describe('buildForkSeedPrompt', () => {
  test('frames the summary as context, not as an instruction to execute', () => {
    const seed = buildForkSeedPrompt('GOAL -- ship it', 'Slug hunt')
    expect(seed).toContain('Slug hunt')
    expect(seed).toContain('GOAL -- ship it')
    // The guard that stops a forked agent charging ahead before the user speaks.
    expect(seed).toContain('wait for the user')
  })
})

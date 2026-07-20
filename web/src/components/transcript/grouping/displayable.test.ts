import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { hasRenderableMessageContent, isDisplayableEntry, isToolResultUserEntry } from './parsers'

const e = (o: unknown) => o as TranscriptEntry
const sys = (subtype: string, content?: string) => e({ type: 'system', subtype, content })
const userText = (t: string) => e({ type: 'user', message: { role: 'user', content: t } })
const userBlocks = (content: unknown[]) => e({ type: 'user', message: { role: 'user', content } })
const asstBlocks = (content: unknown[]) => e({ type: 'assistant', message: { role: 'assistant', content } })

describe('isDisplayableEntry -- window budget predicate', () => {
  it('drops the per-request status heartbeat (the dominant noise)', () => {
    expect(isDisplayableEntry(sys('status'))).toBe(false)
  })

  it('drops the other transcript-invisible system subtypes', () => {
    for (const s of ['file_snapshot', 'post_turn_summary', 'task_progress', 'task_notification']) {
      expect(isDisplayableEntry(sys(s))).toBe(false)
    }
  })

  it('keeps system subtypes that DO render (informational, away_summary)', () => {
    expect(isDisplayableEntry(sys('informational', 'hi'))).toBe(true)
    expect(isDisplayableEntry(sys('away_summary', '{}'))).toBe(true)
  })

  it('drops a tool_result user entry (renders inside its tool_use line)', () => {
    const tr = userBlocks([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])
    expect(isToolResultUserEntry(tr)).toBe(true)
    expect(isDisplayableEntry(tr)).toBe(false)
  })

  it('keeps a real user text turn', () => {
    expect(isDisplayableEntry(userText('do the thing'))).toBe(true)
    expect(isDisplayableEntry(userBlocks([{ type: 'text', text: 'do the thing' }]))).toBe(true)
  })

  it('keeps an assistant message with text or a tool_use, drops an empty one', () => {
    expect(isDisplayableEntry(asstBlocks([{ type: 'text', text: 'sure' }]))).toBe(true)
    expect(isDisplayableEntry(asstBlocks([{ type: 'tool_use', name: 'Bash', input: {} }]))).toBe(true)
    expect(isDisplayableEntry(asstBlocks([]))).toBe(false)
    expect(isDisplayableEntry(userText(''))).toBe(false)
  })

  it('keeps non-message card entries (boot/launch/shell/advisor)', () => {
    for (const t of ['boot', 'launch', 'shell', 'advisor', 'spawn_notification']) {
      expect(isDisplayableEntry(e({ type: t }))).toBe(true)
    }
  })

  it('hasRenderableMessageContent gates empties correctly', () => {
    expect(hasRenderableMessageContent(userText(' '))).toBe(false)
    expect(hasRenderableMessageContent(asstBlocks([{ type: 'thinking', thinking: 'x' }]))).toBe(true)
    expect(hasRenderableMessageContent(asstBlocks([{ type: 'text', text: '' }]))).toBe(false)
  })
})

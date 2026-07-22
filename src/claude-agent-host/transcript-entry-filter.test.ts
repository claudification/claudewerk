import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { isHeadlessLiveEntry, selectForwardableEntries } from './transcript-entry-filter'

const user = { type: 'user', message: { content: 'hi' } } as TranscriptEntry
const assistant = { type: 'assistant', message: { content: 'yo' } } as TranscriptEntry
const enqueue = { type: 'queue-operation', operation: 'enqueue', content: 'hi' } as unknown as TranscriptEntry
const remove = { type: 'queue-operation', operation: 'remove', content: 'hi' } as unknown as TranscriptEntry
const attachment = { type: 'attachment' } as unknown as TranscriptEntry
const lastPrompt = { type: 'last-prompt' } as unknown as TranscriptEntry

const batch = [user, enqueue, assistant, remove, attachment, lastPrompt]

describe('selectForwardableEntries', () => {
  describe('PTY / daemon (headless: false)', () => {
    it('forwards everything, incremental', () => {
      expect(selectForwardableEntries(batch, { headless: false, isInitial: false })).toEqual(batch)
    })

    it('forwards everything, isInitial', () => {
      expect(selectForwardableEntries(batch, { headless: false, isInitial: true })).toEqual(batch)
    })
  })

  describe('headless', () => {
    it('forwards ONLY the JSONL-only types on the incremental tail', () => {
      // stdout already delivered user/assistant live -- re-sending them from
      // the file would duplicate the entire transcript.
      expect(selectForwardableEntries(batch, { headless: true, isInitial: false })).toEqual([enqueue, remove])
    })

    it('forwards the full record MINUS live AND never types on an isInitial batch', () => {
      // isInitial REPLACES the broker's transcript cache, so it must carry the
      // conversation itself -- but NOT the JSONL-only no-renderer types, which
      // would otherwise re-insert at the tail on every resend (the regression).
      expect(selectForwardableEntries(batch, { headless: true, isInitial: true })).toEqual([user, assistant])
    })

    it('drops attachment / last-prompt from BOTH cells (no renderer, resend-only)', () => {
      const live = selectForwardableEntries(batch, { headless: true, isInitial: false })
      const initial = selectForwardableEntries(batch, { headless: true, isInitial: true })
      for (const neverEntry of [attachment, lastPrompt]) {
        expect(live).not.toContain(neverEntry)
        expect(initial).not.toContain(neverEntry)
      }
      // Everything else is still forwarded in exactly one cell.
      for (const entry of batch.filter(e => e !== attachment && e !== lastPrompt)) {
        expect(live.includes(entry) || initial.includes(entry)).toBe(true)
        expect(live.includes(entry) && initial.includes(entry)).toBe(false)
      }
    })
  })

  it('keeps attachment / last-prompt out of the live set until something renders them', () => {
    // They are equally invisible to stdout, but widening the live set also
    // narrows the initial batch -- do both together or neither.
    expect(isHeadlessLiveEntry(attachment)).toBe(false)
    expect(isHeadlessLiveEntry({ type: 'last-prompt' } as unknown as TranscriptEntry)).toBe(false)
    expect(isHeadlessLiveEntry(enqueue)).toBe(true)
  })

  it('tolerates entries with no type', () => {
    const untyped = {} as TranscriptEntry
    expect(isHeadlessLiveEntry(untyped)).toBe(false)
    expect(selectForwardableEntries([untyped], { headless: true, isInitial: false })).toEqual([])
    expect(selectForwardableEntries([untyped], { headless: true, isInitial: true })).toEqual([untyped])
  })
})

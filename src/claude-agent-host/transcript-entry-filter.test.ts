import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { isHeadlessLiveEntry, selectForwardableEntries } from './transcript-entry-filter'

const user = { type: 'user', message: { content: 'hi' } } as TranscriptEntry
const assistant = { type: 'assistant', message: { content: 'yo' } } as TranscriptEntry
const enqueue = { type: 'queue-operation', operation: 'enqueue', content: 'hi' } as unknown as TranscriptEntry
const remove = { type: 'queue-operation', operation: 'remove', content: 'hi' } as unknown as TranscriptEntry
const attachment = { type: 'attachment' } as unknown as TranscriptEntry

const batch = [user, enqueue, assistant, remove, attachment]

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

    it('forwards the full record MINUS those types on an isInitial batch', () => {
      // isInitial REPLACES the broker's transcript cache, so it must carry the
      // conversation itself, not just queue transitions.
      expect(selectForwardableEntries(batch, { headless: true, isInitial: true })).toEqual([
        user,
        assistant,
        attachment,
      ])
    })

    it('the two headless columns are exact complements', () => {
      const live = selectForwardableEntries(batch, { headless: true, isInitial: false })
      const initial = selectForwardableEntries(batch, { headless: true, isInitial: true })

      expect(live.length + initial.length).toBe(batch.length)
      expect(live.filter(e => initial.includes(e))).toEqual([])
      for (const entry of batch) {
        expect(live.includes(entry) || initial.includes(entry)).toBe(true)
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

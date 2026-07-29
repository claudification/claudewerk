import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { renamedTitleOf, renameRequestsIn } from './detect-rename'

const CONV = 'conv-1234'
const TS = '2026-07-29T07:24:09.459Z'
const TS_MS = Date.parse(TS)

/** The PTY / daemon shape: CC's slash-command stdout, straight out of the JSONL.
 *  Pass `timestamp: null` for the undated case -- omitting the arg means "use TS". */
function localCommandEntry(title: string, timestamp: string | null = TS): TranscriptEntry {
  return {
    type: 'system',
    subtype: 'local_command',
    content: `<local-command-stdout>Session renamed to: ${title}</local-command-stdout>`,
    ...(timestamp === null ? {} : { timestamp }),
  } as unknown as TranscriptEntry
}

/** The headless shape: a synthetic (locally generated, no API call) assistant reply. */
function syntheticAssistantEntry(text: string, model = '<synthetic>'): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: TS,
    message: { model, role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}

describe('renamedTitleOf', () => {
  it('reads the PTY / daemon local_command shape', () => {
    expect(renamedTitleOf(localCommandEntry('turbo-dagger'))).toBe('turbo-dagger')
  })

  it('reads the headless synthetic-assistant shape', () => {
    expect(renamedTitleOf(syntheticAssistantEntry('Session renamed to: probe-xyz'))).toBe('probe-xyz')
  })

  it('IGNORES a real assistant that merely writes the sentence', () => {
    const impostor = syntheticAssistantEntry('Session renamed to: gotcha', 'claude-opus-5')
    expect(renamedTitleOf(impostor)).toBeUndefined()
  })

  it('ignores ordinary entries', () => {
    expect(renamedTitleOf({ type: 'user', timestamp: TS } as unknown as TranscriptEntry)).toBeUndefined()
    expect(renamedTitleOf({ type: 'custom-title', customTitle: 'x' } as unknown as TranscriptEntry)).toBeUndefined()
    expect(
      renamedTitleOf({
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Settings dialog dismissed</local-command-stdout>',
      } as unknown as TranscriptEntry),
    ).toBeUndefined()
  })

  it('stops at the closing tag rather than swallowing it', () => {
    expect(renamedTitleOf(localCommandEntry('a-b-c'))).toBe('a-b-c')
  })
})

describe('renameRequestsIn', () => {
  it('emits a dated, user-origin rename addressed to OUR conversation id', () => {
    expect(renameRequestsIn(CONV, [localCommandEntry('fix-phantoms')])).toEqual([
      { type: 'rename_conversation', conversationId: CONV, name: 'fix-phantoms', origin: 'user', at: TS_MS },
    ])
  })

  it('carries the timestamp CC wrote, NOT the time we happened to read it', () => {
    const hourOld = '2026-07-29T06:24:09.459Z'
    const [msg] = renameRequestsIn(CONV, [localCommandEntry('old-name', hourOld)])
    expect(msg.at).toBe(Date.parse(hourOld))
  })

  it('leaves `at` undefined when the entry is undated, so the broker stamps its own', () => {
    const [msg] = renameRequestsIn(CONV, [localCommandEntry('undated', null)])
    expect(msg.at).toBeUndefined()
  })

  it('emits nothing for a batch with no rename', () => {
    expect(renameRequestsIn(CONV, [{ type: 'user', timestamp: TS } as unknown as TranscriptEntry])).toEqual([])
  })

  it('emits every rename in order when a batch holds several', () => {
    const msgs = renameRequestsIn(CONV, [localCommandEntry('first'), localCommandEntry('second')])
    expect(msgs.map(m => m.name)).toEqual(['first', 'second'])
  })

  it('does not filter replays -- staleness is the broker&apos;s call, by timestamp', () => {
    // Both shapes of the SAME rename (headless writes both) produce two messages.
    // Idempotent downstream: same name, so title-authority rejects the second as
    // unchanged. Filtering here would mean guessing which batch is a replay --
    // the exact mistake 1afa4954 documents.
    const msgs = renameRequestsIn(CONV, [
      localCommandEntry('same-name'),
      syntheticAssistantEntry('Session renamed to: same-name'),
    ])
    expect(msgs).toHaveLength(2)
    expect(new Set(msgs.map(m => m.name))).toEqual(new Set(['same-name']))
  })
})

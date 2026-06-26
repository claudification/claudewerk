import { describe, expect, it } from 'bun:test'
import type { ScribeNote, TranscriptEntry, TurnDigest } from '../shared/protocol'
import { SotuEmitter } from './sotu-emit'

function assistant(content: unknown): TranscriptEntry {
  return { type: 'assistant', timestamp: 't', message: { role: 'assistant', content }, uuid: 'u' } as TranscriptEntry
}
function user(content: unknown, isMeta = false): TranscriptEntry {
  return { type: 'user', timestamp: 't', message: { role: 'user', content }, uuid: 'u', isMeta } as TranscriptEntry
}

function makeEmitter() {
  const sent: (ScribeNote | TurnDigest)[] = []
  const e = new SotuEmitter('conv-1', m => sent.push(m))
  return { e, sent }
}

describe('SotuEmitter -- callouts', () => {
  it('emits a scribe_note for an inline callout in assistant prose', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([
      assistant([{ type: 'text', text: 'before <callout type="insight">x is dead</callout> after' }]),
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'scribe_note',
      noteType: 'insight',
      payload: 'x is dead',
      weight: 'high',
      convId: 'conv-1',
    })
  })

  it('forwards a lock callout path as a claim target', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([assistant([{ type: 'text', text: '<callout type="lock" path="src/x.ts">~1h</callout>' }])])
    expect(sent[0]).toMatchObject({
      type: 'scribe_note',
      noteType: 'lock',
      target: { kind: 'claim', path: 'src/x.ts' },
    })
  })

  it('reassembles a callout that spans two assistant messages within a turn', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([assistant([{ type: 'text', text: 'note: <callout type="blocked">waiting on ' }])])
    expect(sent).toHaveLength(0)
    e.observeLiveEntries([assistant([{ type: 'text', text: 'daemon fix</callout> ok' }])])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ noteType: 'blocked', payload: 'waiting on daemon fix' })
  })

  it('ignores tool_use and string content for callouts', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }])])
    e.observeLiveEntries([assistant('plain string, no callout here')])
    expect(sent.filter(m => m.type === 'scribe_note')).toHaveLength(0)
  })
})

describe('SotuEmitter -- turn digest', () => {
  it('emits a baseline turn_digest at turn end with intent + touched files', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([user('add the callout parser')])
    e.observeLiveEntries([assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'src/a.ts' } }])])
    e.flushTurn({ subtype: 'success', result_text: 'done' })
    const digest = sent.find(m => m.type === 'turn_digest') as TurnDigest
    expect(digest).toBeDefined()
    expect(digest).toMatchObject({
      type: 'turn_digest',
      convId: 'conv-1',
      intent: 'add the callout parser',
      touching: ['src/a.ts'],
      result: 'done',
    })
  })

  it('does NOT use a meta (skill-injected) user message as intent', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([user('SKILL CONTENT injected', true)])
    e.flushTurn()
    expect(sent.find(m => m.type === 'turn_digest')).toBeUndefined()
  })

  it('emits nothing at turn end when nothing meaningful happened', () => {
    const { e, sent } = makeEmitter()
    e.flushTurn({ subtype: 'success' })
    expect(sent).toHaveLength(0)
  })

  it('resets between turns -- a second turn does not inherit the first turn state', () => {
    const { e, sent } = makeEmitter()
    e.observeLiveEntries([
      user('first turn'),
      assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }]),
    ])
    e.flushTurn({ subtype: 'success' })
    sent.length = 0
    // New turn: only a fresh assistant text callout, no inherited intent/files.
    e.observeLiveEntries([assistant([{ type: 'text', text: '<callout type="focus">phase 4</callout>' }])])
    e.flushTurn({ subtype: 'success' })
    const digest = sent.find(m => m.type === 'turn_digest') as TurnDigest | undefined
    expect(digest).toBeUndefined() // a callout is not a digest signal; no intent/files this turn
    expect(sent.filter(m => m.type === 'scribe_note')).toHaveLength(1)
  })
})

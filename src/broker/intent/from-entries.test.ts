import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry } from '../../shared/protocol'
import { intentContextFromEntries } from './from-entries'

const user = (text: string, timestamp = '2026-08-19T10:00:00.000Z') =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp,
  }) as unknown as TranscriptEntry

const assistant = (blocks: unknown[]) =>
  ({ type: 'assistant', message: { role: 'assistant', content: blocks } }) as unknown as TranscriptEntry

describe('intentContextFromEntries', () => {
  test('pulls human turns with their clocks', () => {
    const ctx = intentContextFromEntries([user('fix the spawn timeout', '2026-08-19T10:00:00.000Z')])
    expect(ctx.userMessages).toEqual([{ text: 'fix the spawn timeout', atMs: Date.parse('2026-08-19T10:00:00.000Z') }])
  })

  // The bug the benchmark surfaced: hook output arrives on a user turn, and
  // conversations were naming themselves after our own tooling.
  test('drops harness-injected turns', () => {
    const ctx = intentContextFromEntries([
      user('Stop hook feedback: You did real work this turn but never called set_status.'),
      user('<system-reminder>do a thing</system-reminder>'),
      user('the real ask'),
    ])
    expect(ctx.userMessages.map(m => m.text)).toEqual(['the real ask'])
  })

  test('lifts the Bash description as activity', () => {
    const ctx = intentContextFromEntries([
      assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Run the tests' } }]),
    ])
    expect(ctx.activity).toEqual(['[Bash] Run the tests'])
  })

  test('falls back to the bare tool name', () => {
    const ctx = intentContextFromEntries([assistant([{ type: 'tool_use', name: 'Read', input: {} }])])
    expect(ctx.activity).toEqual(['[Read]'])
  })

  test('joins assistant prose with its tool calls', () => {
    const ctx = intentContextFromEntries([
      assistant([
        { type: 'text', text: 'Checking that.' },
        { type: 'tool_use', name: 'Bash', input: { description: 'List files' } },
      ]),
    ])
    expect(ctx.activity).toEqual(['Checking that. | [Bash] List files'])
  })

  test('bounds the activity tail', () => {
    const entries = Array.from({ length: 40 }, (_, i) => assistant([{ type: 'tool_use', name: `T${i}`, input: {} }]))
    expect(intentContextFromEntries(entries, 3).activity).toEqual(['[T37]', '[T38]', '[T39]'])
  })

  test('ignores system entries and survives an empty transcript', () => {
    expect(intentContextFromEntries([])).toEqual({ userMessages: [], activity: [] })
    const ctx = intentContextFromEntries([{ type: 'system', subtype: 'away_summary' } as unknown as TranscriptEntry])
    expect(ctx).toEqual({ userMessages: [], activity: [] })
  })
})

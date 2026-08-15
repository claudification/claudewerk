import { applyInputSourceHint } from '@shared/voice-hint'
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { processEntry } from './grouping/process-entry'
import type { GroupingState } from './grouping/types'
import { parseGroupEntries } from './parse-entries'

const noResult = () => undefined

function userEntry(content: string | Array<{ type: 'text'; text: string }>): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-08-15T10:00:00.000Z',
    message: { role: 'user', content },
  } as unknown as TranscriptEntry
}

function group(entries: TranscriptEntry[]): GroupingState {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const e of entries) processEntry(e, state)
  return state
}

describe('dictated user entries', () => {
  const spoken = 'wrap it in a voice container so the receiver knows'
  const dictated = applyInputSourceHint(spoken, 'voice')

  it('strips the hint and flags the item as voice (string content)', () => {
    const items = parseGroupEntries([userEntry(dictated)], noResult)
    expect(items).toEqual([{ kind: 'text', text: spoken, voice: true }])
  })

  it('strips the hint off the first block (array content)', () => {
    const items = parseGroupEntries(
      [
        userEntry([
          { type: 'text', text: `${dictated}` },
          { type: 'text', text: 'trailing block' },
        ]),
      ],
      noResult,
    )
    expect(items).toEqual([
      { kind: 'text', text: spoken, voice: true },
      { kind: 'text', text: 'trailing block', voice: true },
    ])
  })

  it('leaves a typed message unflagged', () => {
    const items = parseGroupEntries([userEntry('typed normally')], noResult)
    expect(items).toEqual([{ kind: 'text', text: 'typed normally' }])
  })

  it('does not leak voice onto a LATER typed entry in the same group', () => {
    const items = parseGroupEntries([userEntry(dictated), userEntry('typed after')], noResult)
    expect(items).toEqual([
      { kind: 'text', text: spoken, voice: true },
      { kind: 'text', text: 'typed after' },
    ])
  })

  // The regression that nearly shipped: process-entry drops ANY user entry
  // containing <system-reminder>, which would have silently deleted the user's
  // own dictated messages from the transcript.
  it('SURVIVES the system-reminder drop guard', () => {
    const { groups, current } = group([userEntry(dictated)])
    const all = current ? [...groups, current] : groups
    expect(all.some(g => g.type === 'user')).toBe(true)
  })

  it('still drops an unrelated system-reminder entry', () => {
    const { groups, current } = group([userEntry('<system-reminder>housekeeping</system-reminder>')])
    const all = current ? [...groups, current] : groups
    expect(all.some(g => g.type === 'user')).toBe(false)
  })
})

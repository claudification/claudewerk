/**
 * Regression: a transcript REPLAY must never drag a renamed conversation back
 * to the name CC knows.
 *
 * The bug: every resync (broker restart, host reconnect, revive, truncation
 * recovery) re-sends the whole JSONL as `isInitial`. CC's `custom-title`
 * control line holds the LAUNCH name, which is older than any rename the user
 * made since -- and `handleCustomTitleEntry` applied it unconditionally. One
 * broker restart on 2026-07-28 fired 3242 `[meta] title` writes across ~40
 * conversations, reverting every renamed one to its launch name.
 */

import { describe, expect, it } from 'bun:test'
import type { Conversation, TranscriptCustomTitleEntry } from '../../../shared/protocol'
import { handleAgentNameEntry, handleCustomTitleEntry, handleSummaryEntry } from './metadata-entry'

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return { id: 'conv_1', title: undefined, ...overrides } as Conversation
}

const titleEntry = (customTitle: string) => ({ type: 'custom-title', customTitle }) as TranscriptCustomTitleEntry

describe('handleCustomTitleEntry', () => {
  it('REGRESSION: a replayed launch name never clobbers a user-set title', () => {
    const c = conv({ title: 'bug-rename-clobber', titleUserSet: true })

    const changed = handleCustomTitleEntry('conv_1', c, titleEntry('stellar-cobra'), true)

    expect(changed).toBe(false)
    expect(c.title).toBe('bug-rename-clobber')
  })

  it('a replay still fills in a title that was never user-set', () => {
    const c = conv({ title: undefined, titleUserSet: false })

    expect(handleCustomTitleEntry('conv_1', c, titleEntry('stellar-cobra'), true)).toBe(true)
    expect(c.title).toBe('stellar-cobra')
  })

  it('a LIVE /rename inside CC wins even over a user-set title (it IS a user action)', () => {
    const c = conv({ title: 'old-name', titleUserSet: true })

    expect(handleCustomTitleEntry('conv_1', c, titleEntry('typed-in-cc'), false)).toBe(true)
    expect(c.title).toBe('typed-in-cc')
  })

  it('an unchanged title reports no change -- no re-broadcast, no log spam on replay', () => {
    const c = conv({ title: 'stellar-cobra', titleUserSet: false })

    expect(handleCustomTitleEntry('conv_1', c, titleEntry('stellar-cobra'), true)).toBe(false)
    expect(c.title).toBe('stellar-cobra')
  })

  it('ignores a blank/missing title', () => {
    const c = conv({ title: 'keep-me' })

    expect(handleCustomTitleEntry('conv_1', c, titleEntry('   '), false)).toBe(false)
    expect(handleCustomTitleEntry('conv_1', c, {} as TranscriptCustomTitleEntry, false)).toBe(false)
    expect(c.title).toBe('keep-me')
  })
})

describe('sibling metadata handlers', () => {
  it('summary reports no change when the replayed value is identical', () => {
    const c = conv({ summary: 'same summary' })

    expect(handleSummaryEntry('conv_1', c, { type: 'summary', summary: 'same summary' } as never)).toBe(false)
    expect(handleSummaryEntry('conv_1', c, { type: 'summary', summary: 'new summary' } as never)).toBe(true)
    expect(c.summary).toBe('new summary')
  })

  it('agent name reports no change when the replayed value is identical', () => {
    const c = conv({ agentName: 'git' })

    expect(handleAgentNameEntry('conv_1', c, { type: 'agent-name', agentName: 'git' } as never)).toBe(false)
    expect(handleAgentNameEntry('conv_1', c, { type: 'agent-name', agentName: 'reviewer' } as never)).toBe(true)
    expect(c.agentName).toBe('reviewer')
  })
})

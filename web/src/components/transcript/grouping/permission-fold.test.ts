/**
 * @vitest-environment node
 */
/**
 * One permission gate must render as ONE card, even though it arrives as two
 * append-only entries (the ask, then the receipt). These cover the fold and the
 * cases where there is nothing to fold into.
 */

import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { processEntry } from './process-entry'
import type { GroupingState } from './types'

function group(entries: TranscriptEntry[]): GroupingState {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const e of entries) processEntry(e, state)
  return state
}

function ask(requestId: string): TranscriptEntry {
  return {
    type: 'permission_request',
    timestamp: '2026-08-19T10:00:00.000Z',
    conversationId: 'conv-1',
    requestId,
    toolName: 'Bash',
    inputPreview: '{"command":"ls"}',
  } as unknown as TranscriptEntry
}

function receipt(requestId: string, outcome = 'allowed'): TranscriptEntry {
  return {
    type: 'permission_decision',
    timestamp: '2026-08-19T10:00:12.000Z',
    conversationId: 'conv-1',
    requestId,
    toolName: 'Bash',
    outcome,
    decidedAt: 1,
    decidedBy: 'jonas',
    waitedMs: 12_000,
  } as unknown as TranscriptEntry
}

function assistant(text: string): TranscriptEntry {
  return {
    type: 'assistant',
    timestamp: '2026-08-19T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}

describe('permission gate grouping', () => {
  it('opens a card of its own for the ask', () => {
    const { groups } = group([ask('r1')])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('permission')
    expect(groups[0].entries).toHaveLength(1)
  })

  it('folds the receipt into the ask it answers instead of adding a second card', () => {
    const { groups } = group([ask('r1'), receipt('r1')])
    expect(groups).toHaveLength(1)
    expect(groups[0].entries).toHaveLength(2)
    expect((groups[0].entries[1] as { outcome: string }).outcome).toBe('allowed')
  })

  it('still folds when turns landed between the ask and the answer', () => {
    const { groups } = group([ask('r1'), assistant('thinking'), receipt('r1')])
    const permissionGroups = groups.filter(g => g.type === 'permission')
    expect(permissionGroups).toHaveLength(1)
    expect(permissionGroups[0].entries).toHaveLength(2)
  })

  it('folds each gate into its own card when several are open', () => {
    const { groups } = group([ask('r1'), ask('r2'), receipt('r2'), receipt('r1')])
    const permissionGroups = groups.filter(g => g.type === 'permission')
    expect(permissionGroups).toHaveLength(2)
    for (const g of permissionGroups) {
      expect(g.entries).toHaveLength(2)
      const [head, tail] = g.entries as Array<{ requestId: string }>
      expect(head.requestId).toBe(tail.requestId)
    }
  })

  it('replaces the group object rather than mutating it, so React sees a new reference', () => {
    const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
    processEntry(ask('r1'), state)
    const before = state.groups[0]
    processEntry(receipt('r1'), state)
    expect(state.groups[0]).not.toBe(before)
    expect(before.entries).toHaveLength(1)
  })

  it('stands the receipt on its own card when the ask is not in the window', () => {
    const { groups } = group([receipt('r-orphan', 'expired')])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('permission')
    expect(groups[0].entries).toHaveLength(1)
  })

  it('ignores a duplicate receipt for an already-resolved gate', () => {
    const { groups } = group([ask('r1'), receipt('r1'), receipt('r1', 'denied')])
    const permissionGroups = groups.filter(g => g.type === 'permission')
    // The already-folded card keeps its first answer; the duplicate lands on its
    // own card rather than silently overwriting the recorded outcome.
    expect(permissionGroups[0].entries).toHaveLength(2)
    expect((permissionGroups[0].entries[1] as { outcome: string }).outcome).toBe('allowed')
  })
})

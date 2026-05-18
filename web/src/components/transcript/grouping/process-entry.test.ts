import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { processEntry } from './process-entry'
import type { GroupingState } from './types'

function group(entries: TranscriptEntry[]): GroupingState {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const e of entries) processEntry(e, state)
  return state
}

// CC delivers Stop/SubagentStop hook feedback as a plain user entry (NOT
// isMeta) whose message.content is a text-block array. `userEntry` accepts a
// bare string too, to cover the legacy/string-content shape.
function userEntry(content: string | { type: 'text'; text: string }[]): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-16T21:20:00.000Z',
    message: { role: 'user', content },
  } as unknown as TranscriptEntry
}

function textBlocks(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text }]
}

describe('processEntry - Stop hook feedback', () => {
  it('routes Stop hook feedback (array content, the real CC shape) to a system group', () => {
    const { groups } = group([
      userEntry(textBlocks('Stop hook feedback:\nIt looks like you have uncommitted work:\n\n M a.ts')),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('system')
    expect(groups[0].systemSubtype).toBe('hook_feedback')
  })

  it('also routes Stop hook feedback delivered as a bare string', () => {
    const { groups } = group([userEntry('Stop hook feedback:\nsome reason')])
    expect(groups[0]?.type).toBe('system')
    expect(groups[0]?.systemSubtype).toBe('hook_feedback')
  })

  it('also catches SubagentStop hook feedback', () => {
    const { groups } = group([userEntry(textBlocks('SubagentStop hook feedback:\nFinish the task first.'))])
    expect(groups[0]?.type).toBe('system')
    expect(groups[0]?.systemSubtype).toBe('hook_feedback')
  })

  it('leaves a real user message that merely mentions a hook as a user group', () => {
    const { groups } = group([userEntry('can you check the Stop hook feedback: behaviour?')])
    expect(groups[0]?.type).toBe('user')
  })

  it('does not reclassify a message that opens with the phrase but lacks the newline', () => {
    const { groups } = group([userEntry('Stop hook feedback: inline mention, no newline after the colon')])
    expect(groups[0]?.type).toBe('user')
  })
})

// The Skill tool produces two consecutive user entries: a tool_result carrying
// `toolUseResult.commandName`, then the big markdown dump. The broker strips
// CC's `isMeta` / `sourceToolUseID` fields, so detection keys on content shape.
const SKILL_BODY = `Base directory for this skill: /Users/jonas/.claude/skills/minimalist-skill\n\n# Protocol\n${'x'.repeat(400)}`

function skillToolResult(commandName: string): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-18T17:21:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
    toolUseResult: { success: true, commandName },
  } as unknown as TranscriptEntry
}

describe('processEntry - Skill content', () => {
  it('collapses skill content into a skill group (broker-stored shape, no isMeta)', () => {
    const { groups } = group([skillToolResult('minimalist-skill'), userEntry(textBlocks(SKILL_BODY))])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('skill')
    expect(groups[0].skillName).toBe('minimalist-skill')
  })

  it('leaves a big markdown user message alone when no skill was just invoked', () => {
    const { groups } = group([userEntry(textBlocks(SKILL_BODY))])
    expect(groups[0]?.type).toBe('user')
  })
})

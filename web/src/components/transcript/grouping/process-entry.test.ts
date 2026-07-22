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
function userEntry(content: string | { type: 'text'; text: string }[], seq?: number): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-16T21:20:00.000Z',
    ...(seq !== undefined ? { seq } : {}),
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

describe('processEntry - harness nag suppression', () => {
  it('suppresses the "no visible output" nag injected by CC harness', () => {
    const { groups } = group([
      userEntry(
        textBlocks(
          '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
        ),
      ),
    ])
    expect(groups).toHaveLength(0)
  })

  it('suppresses the nag delivered as a bare string too', () => {
    const { groups } = group([
      userEntry('[Your previous response had no visible output. Please continue and produce a user-visible response.]'),
    ])
    expect(groups).toHaveLength(0)
  })
})

// The Skill tool produces a tool_result carrying `toolUseResult.commandName`,
// then the big markdown dump. The agent host marks the dump `isMeta` -- native
// in CC's JSONL (PTY), normalized from stream-json `isSynthetic` (headless).
const SKILL_BODY = `Base directory for this skill: /Users/jonas/.claude/skills/minimalist-skill\n\n# Protocol\n${'x'.repeat(400)}`

function skillToolResult(commandName: string): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-18T17:21:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
    toolUseResult: { success: true, commandName },
  } as unknown as TranscriptEntry
}

function skillContent(body: string): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-18T17:21:00.000Z',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text: body }] },
  } as unknown as TranscriptEntry
}

describe('processEntry - Skill content', () => {
  it('collapses skill content into a skill group', () => {
    const { groups } = group([skillToolResult('minimalist-skill'), skillContent(SKILL_BODY)])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('skill')
    expect(groups[0].skillName).toBe('minimalist-skill')
  })

  it('does not collapse a meta dump with no preceding Skill tool call', () => {
    const { groups } = group([skillContent(SKILL_BODY)])
    expect(groups[0]?.type).toBe('user')
  })

  it('leaves a non-meta markdown message as a normal user group', () => {
    const { groups } = group([skillToolResult('minimalist-skill'), userEntry(textBlocks(SKILL_BODY))])
    expect(groups[0]?.type).toBe('user')
  })
})

// A direct /slash command (Path B) arrives as a user entry whose string content
// holds <command-message>name</command-message> + <command-name>/name</command-name>.
// Built-ins like /insights then inject a meta payload that does NOT look like a
// classic skill body (it opens with prose, not `#`).
function slashCommand(name: string): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-06-07T06:10:09.000Z',
    message: {
      role: 'user',
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`,
    },
  } as unknown as TranscriptEntry
}

const INSIGHTS_PAYLOAD = `The user just ran /insights to generate a usage report.\n\n${'x'.repeat(400)}`

describe('processEntry - slash command chips', () => {
  it('renders a /slash command invocation as a command chip', () => {
    const { groups } = group([slashCommand('insights')])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('skill')
    expect(groups[0].skillName).toBe('insights')
    // No body injected yet -- the chip stands on its own.
    expect(groups[0].entries).toHaveLength(0)
  })

  it('folds a built-in command payload into the chip as its expandable body', () => {
    const { groups } = group([slashCommand('insights'), skillContent(INSIGHTS_PAYLOAD)])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('skill')
    expect(groups[0].skillName).toBe('insights')
    expect(groups[0].entries).toHaveLength(1)
  })

  it('never renders the injected payload as a raw standalone user bubble', () => {
    const { groups } = group([slashCommand('insights'), skillContent(INSIGHTS_PAYLOAD)])
    expect(groups.some(g => g.type === 'user')).toBe(false)
  })
})

// An inter-conversation / dialog / system <channel> card arrives as a user-role
// entry. The control panel renders it as a full-width self-describing box, so it
// must NOT share a group with the user's own typed text -- a merged group bails
// the whole group out of bubble mode and the user's text renders bare. The
// grouper splits the channel card from the plain user turn.
const INTER_CONV_CHANNEL =
  '<channel sender="conversation" from_conversation="batch-commands" from_project="remote-claude" intent="response">\nThanks, confirmed.\n</channel>'

describe('processEntry - channel card vs user text', () => {
  it('splits an inter-conversation card from the user text that follows it', () => {
    const { groups } = group([userEntry(INTER_CONV_CHANNEL), userEntry('output to a FULL ON DOC!')])
    expect(groups).toHaveLength(2)
    expect(groups[0].type).toBe('user')
    expect(groups[1].type).toBe('user')
    expect(groups[0].entries).toHaveLength(1)
    expect(groups[1].entries).toHaveLength(1)
  })

  it('splits when the user types first and a card arrives after', () => {
    const { groups } = group([userEntry('my message'), userEntry(INTER_CONV_CHANNEL)])
    expect(groups).toHaveLength(2)
    expect(groups[0].entries).toHaveLength(1)
    expect(groups[1].entries).toHaveLength(1)
  })

  it('still merges consecutive plain user turns into one group', () => {
    const { groups } = group([userEntry('first'), userEntry('second')])
    expect(groups).toHaveLength(1)
    expect(groups[0].entries).toHaveLength(2)
  })

  it('keeps consecutive channel cards together (no bubble involved)', () => {
    const second = INTER_CONV_CHANNEL.replace('Thanks, confirmed.', 'And one more thing.')
    const { groups } = group([userEntry(INTER_CONV_CHANNEL), userEntry(second)])
    expect(groups).toHaveLength(1)
    expect(groups[0].entries).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// queue-operation
// ---------------------------------------------------------------------------

function queueOp(operation: string, content?: string): TranscriptEntry {
  return {
    type: 'queue-operation',
    timestamp: '2026-07-22T04:41:38.000Z',
    operation,
    ...(content !== undefined ? { content } : {}),
  } as unknown as TranscriptEntry
}

describe('processEntry - queue-operation', () => {
  it('flags the existing user bubble instead of rendering the message twice (headless)', () => {
    // Headless: the agent host emits an optimistic user entry the moment it
    // writes to CC's stdin, so the bubble exists before `enqueue` arrives.
    const { groups } = group([userEntry('deploy the thing'), queueOp('enqueue', 'deploy the thing')])

    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('user')
    expect(groups[0].queued).toBe(true)
  })

  it('creates a queued group when nothing matches (PTY/daemon, no optimistic entry)', () => {
    const { groups } = group([queueOp('enqueue', 'deploy the thing')])

    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('user')
    expect(groups[0].queued).toBe(true)
  })

  it('does not flag a user bubble whose text differs', () => {
    const { groups } = group([userEntry('something else'), queueOp('enqueue', 'deploy the thing')])

    expect(groups).toHaveLength(2)
    expect(groups[0].queued).toBeFalsy()
    expect(groups[1].queued).toBe(true)
  })

  it.each(['remove', 'dequeue'])('clears the queued flag on %s', op => {
    const { groups } = group([userEntry('deploy the thing'), queueOp('enqueue', 'deploy the thing'), queueOp(op)])

    expect(groups).toHaveLength(1)
    expect(groups[0].queued).toBe(false)
  })

  it('clears only the oldest queued group on a single remove (FIFO)', () => {
    // Distinct seq buckets keep the two echoes in SEPARATE user groups (a
    // seq-bucket break stops the merge), so this exercises the genuine
    // two-queued-groups FIFO, not the merged-into-one case below.
    const { groups } = group([
      userEntry('first', 1),
      queueOp('enqueue', 'first'),
      userEntry('second', 20),
      queueOp('enqueue', 'second'),
      queueOp('remove'),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].queued).toBe(false)
    expect(groups[1].queued).toBe(true)
  })

  it('clears every queued group on popAll', () => {
    const { groups } = group([
      userEntry('first', 1),
      queueOp('enqueue', 'first'),
      userEntry('second', 20),
      queueOp('enqueue', 'second'),
      queueOp('popAll'),
    ])

    expect(groups).toHaveLength(2)
    expect(groups.every(g => !g.queued)).toBe(true)
  })

  it('does not duplicate the second of two MERGED queued messages (regression)', () => {
    // Two messages queued back-to-back merge into ONE user group (consecutive
    // user echoes merge). The enqueue for the SECOND then sits at a non-zero
    // index in that group -- flagging must find it there instead of spawning a
    // duplicate synthetic bubble. Real incident 2026-07-22: an image message
    // rendered once inside the first bubble AND again on its own, seconds apart.
    const { groups } = group([
      userEntry('ALSO NOT Updating over shares'),
      userEntry('the image message'), // no seq gap -> merges with the first
      queueOp('enqueue', 'ALSO NOT Updating over shares'),
      queueOp('enqueue', 'the image message'),
    ])

    // One merged group holding both messages, queued -- and crucially NO third
    // (synthetic) bubble echoing the second message.
    expect(groups).toHaveLength(1)
    expect(groups[0].entries).toHaveLength(2)
    expect(groups[0].queued).toBe(true)
    const copiesOfSecond = groups.filter(g =>
      g.entries.some(e => (e as { message?: { content?: unknown } }).message?.content === 'the image message'),
    )
    expect(copiesOfSecond).toHaveLength(1)
  })

  it('replaces the group object rather than mutating it (React #300)', () => {
    const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
    processEntry(userEntry('deploy the thing'), state)
    const before = state.groups[0]

    processEntry(queueOp('enqueue', 'deploy the thing'), state)
    expect(state.groups[0]).not.toBe(before)
    expect(before.queued).toBeFalsy()

    const flagged = state.groups[0]
    processEntry(queueOp('remove'), state)
    expect(state.groups[0]).not.toBe(flagged)
    expect(flagged.queued).toBe(true)
  })
})

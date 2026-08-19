/**
 * The A1 fold: what lands in the queue, which tier it lands in, and whether the
 * button actually reaches the answer path.
 *
 * The answers are a FAKE -- the point of injecting them is that the round-trip
 * can be asserted without a websocket, so "ALLOW really unblocks the
 * conversation" is a test rather than a hope.
 */

import type { DialogLayout } from '@shared/dialog-schema'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation, LiveStatus } from '@/lib/types'
import type { AttentionAnswers } from './attention-entries'
import { type AttentionSources, buildAttentionQueue } from './attention-queue'

const NOW = 1_700_000_000_000

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    project: 'claude:///Users/j/remote-claude',
    status: 'active',
    title: 'wall pane attention',
    startedAt: NOW - 600_000,
    lastActivity: NOW - 60_000,
    ...over,
  } as unknown as Conversation
}

function fakeAnswers(): AttentionAnswers {
  return {
    respondToPermission: vi.fn(),
    allowPermissionAlways: vi.fn(),
    respondToProjectLink: vi.fn(),
    respondToAskQuestion: vi.fn(),
    submitDialog: vi.fn(),
    respondToSpawnApproval: vi.fn(),
  }
}

function sources(over: Partial<AttentionSources> = {}): AttentionSources {
  return {
    permissions: [],
    links: [],
    asks: [],
    dialogs: {},
    conversations: [conv()],
    projectSettings: {},
    flagsFor: () => ({}),
    answers: fakeAnswers(),
    now: NOW,
    ...over,
  }
}

const permission = (over = {}) => ({
  conversationId: 'conv_1',
  requestId: 'req_1',
  toolName: 'Bash',
  description: 'run a command',
  inputPreview: '{"command":"rm -rf /tmp/x"}',
  timestamp: NOW - 120_000,
  ...over,
})

const optionsLayout = (): DialogLayout => ({
  title: 'Which branch?',
  body: [{ type: 'Options', id: 'branch', label: 'Pick one', options: [{ label: 'main' }, { label: 'worktree' }] }],
})

const live = (over: Partial<LiveStatus> = {}): LiveStatus =>
  ({ state: 'needs_you', seq: 1, updatedAt: NOW - 30_000, ...over }) as LiveStatus

describe('the attention queue', () => {
  it('keeps HARD and SOFT apart and leads with the hard block', () => {
    const q = buildAttentionQueue(
      sources({
        permissions: [permission()],
        conversations: [conv(), conv({ id: 'conv_2', liveStatus: live() })],
        flagsFor: id => (id === 'conv_1' ? { hasPendingPermission: true } : {}),
      }),
    )

    expect(q.map(e => e.tier)).toEqual(['hard', 'soft'])
    expect(q[0]?.kind).toBe('permission')
    expect(q[1]?.kind).toBe('needs')
    // A soft row is a report, not a question: nothing here can answer it.
    expect(q[1]?.actions).toHaveLength(0)
  })

  it('sorts each tier OLDEST FIRST -- the one rotting longest leads', () => {
    const q = buildAttentionQueue(
      sources({
        permissions: [
          permission({ requestId: 'young', timestamp: NOW - 10_000 }),
          permission({ requestId: 'old', timestamp: NOW - 720_000 }),
        ],
      }),
    )
    expect(q.map(e => e.key)).toEqual(['perm:old', 'perm:young'])
  })

  it('ALLOW reaches the real permission path, ALWAYS reaches the standing-rule one', () => {
    const answers = fakeAnswers()
    const q = buildAttentionQueue(sources({ permissions: [permission()], answers }))
    const [entry] = q

    entry?.actions.find(a => a.id === 'allow')?.run()
    expect(answers.respondToPermission).toHaveBeenCalledWith('conv_1', 'req_1', 'allow')

    entry?.actions.find(a => a.id === 'always')?.run()
    expect(answers.allowPermissionAlways).toHaveBeenCalledWith('conv_1', 'req_1', 'Bash')

    entry?.actions.find(a => a.id === 'deny')?.run()
    expect(answers.respondToPermission).toHaveBeenCalledWith('conv_1', 'req_1', 'deny')
  })

  it('answers a pick-one dialog through submitDialog, with the option VALUE', () => {
    const answers = fakeAnswers()
    const q = buildAttentionQueue(
      sources({
        dialogs: { conv_1: { dialogId: 'dlg_1', layout: optionsLayout(), timestamp: NOW - 720_000 } },
        answers,
      }),
    )

    expect(q[0]?.actions.map(a => a.label)).toEqual(['main', 'worktree'])
    q[0]?.actions[1]?.run()
    expect(answers.submitDialog).toHaveBeenCalledWith('conv_1', 'dlg_1', {
      branch: 'worktree',
      _action: 'submit',
      _timeout: false,
      _cancelled: false,
    })
  })

  it('answers an AskUserQuestion with the option LABEL, keyed by the question', () => {
    const answers = fakeAnswers()
    const q = buildAttentionQueue(
      sources({
        asks: [
          {
            conversationId: 'conv_1',
            toolUseId: 'tool_1',
            questions: [{ question: 'Ship it?', header: 'ship', options: [{ label: 'yes', description: '' }] }],
            timestamp: NOW - 5_000,
          },
        ],
        answers,
      }),
    )

    q[0]?.actions[0]?.run()
    expect(answers.respondToAskQuestion).toHaveBeenCalledWith('conv_1', 'tool_1', { 'Ship it?': 'yes' })
  })

  it('gives a plan approval its two real outcomes and nothing else', () => {
    const answers = fakeAnswers()
    const q = buildAttentionQueue(
      sources({
        dialogs: {
          conv_1: {
            dialogId: 'plan_req_9',
            layout: { title: 'Plan Approval', body: [] },
            timestamp: NOW - 60_000,
            source: 'plan_approval',
            meta: { requestId: 'req_9' },
          },
        },
        answers,
      }),
    )

    expect(q[0]?.kind).toBe('plan')
    expect(q[0]?.actions.map(a => a.id)).toEqual(['approve', 'reject'])
    q[0]?.actions[1]?.run()
    expect(answers.submitDialog).toHaveBeenCalledWith('conv_1', 'plan_req_9', {
      _action: 'reject',
      _timeout: false,
      _cancelled: false,
    })
  })

  it('LISTS a block it cannot answer instead of hiding it, and says where to answer', () => {
    const q = buildAttentionQueue(
      sources({
        // A wizard: two input blocks, so no single click can answer it.
        dialogs: {
          conv_1: {
            dialogId: 'dlg_2',
            layout: {
              title: 'Configure the run',
              body: [
                { type: 'TextInput', id: 'a', label: 'a' },
                { type: 'TextInput', id: 'b', label: 'b' },
              ],
            },
            timestamp: NOW - 30_000,
          },
        },
      }),
    )

    expect(q[0]?.tier).toBe('hard')
    expect(q[0]?.actions).toHaveLength(0)
    expect(q[0]?.hint).toContain('open the conversation')
  })

  it('drops an EXPIRED dialog -- it blocks nobody', () => {
    const q = buildAttentionQueue(
      sources({
        dialogs: { conv_1: { dialogId: 'dlg_3', layout: optionsLayout(), timestamp: NOW, expired: true } },
      }),
    )
    expect(q).toHaveLength(0)
  })

  it('never lists one gate twice -- the slice wins over the umbrella', () => {
    const q = buildAttentionQueue(
      sources({
        permissions: [permission()],
        conversations: [conv({ pendingAttention: { type: 'permission', toolName: 'Bash', timestamp: NOW } })],
        flagsFor: () => ({ hasPendingPermission: true }),
      }),
    )
    expect(q).toHaveLength(1)
    expect(q[0]?.key).toBe('perm:req_1')
  })

  it('still shows a block whose only witness is the umbrella', () => {
    const q = buildAttentionQueue(
      sources({
        conversations: [conv({ pendingAttention: { type: 'elicitation', question: 'which env?', timestamp: NOW } })],
      }),
    )
    expect(q[0]?.tier).toBe('hard')
    expect(q[0]?.kind).toBe('stuck')
    expect(q[0]?.question).toContain('which env?')
  })

  it('answers a spawn approval and a channel link in place', () => {
    const answers = fakeAnswers()
    const q = buildAttentionQueue(
      sources({
        links: [
          { fromConversation: 'conv_2', fromProject: 'gate', toConversation: 'conv_1', toProject: 'remote-claude' },
        ],
        conversations: [
          conv({
            pendingSpawnApproval: { requestId: 'sp_1', requestedAt: NOW - 90_000, request: {}, reason: 'wants a seat' },
          }),
        ],
        answers,
      }),
    )

    const spawn = q.find(e => e.kind === 'spawn')
    spawn?.actions[0]?.run()
    expect(answers.respondToSpawnApproval).toHaveBeenCalledWith('conv_1', 'sp_1', 'allow', false)

    const link = q.find(e => e.kind === 'link')
    link?.actions[1]?.run()
    expect(answers.respondToProjectLink).toHaveBeenCalledWith('conv_2', 'conv_1', 'block')
  })

  it('an ENDED conversation is never in the queue -- a fossil cannot be answered', () => {
    const q = buildAttentionQueue(sources({ conversations: [conv({ status: 'ended', liveStatus: live() })] }))
    expect(q).toHaveLength(0)
  })
})

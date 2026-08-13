import { beforeEach, describe, expect, it } from 'bun:test'
import type { Conversation, LiveStatus } from '../../shared/protocol'
import type { ConversationLike } from '../conversation-address'
import { relayStatusToWatchers, type StatusRelayDeps } from './orb-status-relay'
import { applyWatch, resetWatches } from './orb-status-watch'

const NOW = 1_700_000_000_000
const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'

function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: 'conv-1', project: PROJECT, title: 'nightshift', ...over } as Conversation
}

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return { state: 'done', seq: 1, updatedAt: NOW, ...over } as LiveStatus
}

/** Deps with a capturing broadcast, so tests assert on what went on the wire. */
function deps(siblings: ConversationLike[] = []): StatusRelayDeps & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    siblings: () => siblings,
    projectLabel: () => null,
    broadcast: m => {
      sent.push(m)
    },
  }
}

beforeEach(() => {
  resetWatches()
})

describe('relayStatusToWatchers', () => {
  it('sends nothing when nobody is watching', () => {
    const d = deps()
    expect(relayStatusToWatchers('conv-1', conv(), status(), 'working', d, NOW)).toBeNull()
    expect(d.sent).toHaveLength(0)
  })

  it('delivers to an orb watching the project', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const d = deps()
    const r = relayStatusToWatchers('conv-1', conv(), status({ done: 'shipped it' }), 'working', d, NOW)

    expect(r).toEqual({ address: 'remote-claude:nightshift', matched: 1 })
    expect(d.sent).toHaveLength(1)
    expect(d.sent[0]).toMatchObject({
      type: 'voice_orb_deliver',
      kind: 'status',
      address: 'remote-claude:nightshift',
      state: 'done',
      prevState: 'working',
      body: 'shipped it',
      sourceConversationId: 'conv-1',
      sourceName: 'nightshift',
      targetOrbId: 'orb-1',
    })
  })

  it('fans out to every matching orb, each addressed to itself', () => {
    applyWatch('orb-1', 'add', ['remote-claude:*'], NOW)
    applyWatch('orb-2', 'add', ['*:nightshift'], NOW)
    const d = deps()
    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', d, NOW)

    expect(r?.matched).toBe(2)
    expect(d.sent.map(m => m.targetOrbId).sort()).toEqual(['orb-1', 'orb-2'])
  })

  it('IGNORES a seq bump that does not move the state', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const d = deps()
    expect(relayStatusToWatchers('conv-1', conv(), status({ state: 'working' }), 'working', d, NOW)).toBeNull()
    expect(d.sent).toHaveLength(0)
  })

  it('ignores a conversation with no project', () => {
    applyWatch('orb-1', 'add', ['*'], NOW)
    const d = deps()
    expect(relayStatusToWatchers('conv-1', conv({ project: '' }), status(), 'working', d, NOW)).toBeNull()
  })

  it('picks the body that matches the state', () => {
    applyWatch('orb-1', 'add', ['*'], NOW)
    const cases: [Partial<LiveStatus>, string][] = [
      [{ state: 'blocked', blocked: 'build fails', pending: 'nope' }, 'build fails'],
      [{ state: 'needs_you', pending: 'pick one', blocked: 'nope' }, 'pick one'],
      [{ state: 'done', done: 'finished' }, 'finished'],
      [{ state: 'done' }, ''],
    ]
    for (const [over, expected] of cases) {
      const d = deps()
      relayStatusToWatchers('conv-1', conv(), status(over), 'working', d, NOW)
      expect(d.sent[0]?.body).toBe(expected)
    }
  })

  it('truncates a giant markdown handoff instead of speaking it whole', () => {
    applyWatch('orb-1', 'add', ['*'], NOW)
    const d = deps()
    relayStatusToWatchers('conv-1', conv(), status({ done: 'x'.repeat(1000) }), 'working', d, NOW)
    expect((d.sent[0]?.body as string).length).toBe(240)
    expect(d.sent[0]?.body).toEndWith('…')
  })

  it('disambiguates the address when two conversations share a title', () => {
    applyWatch('orb-1', 'add', ['remote-claude:*'], NOW)
    const twin: ConversationLike = { id: 'conv-2', project: PROJECT, title: 'nightshift' }
    const d = deps([{ id: 'conv-1', project: PROJECT, title: 'nightshift' }, twin])
    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', d, NOW)
    expect(r?.address).toBe('remote-claude:nightshift-conv-1')
  })

  it('an expired watch stops delivering', () => {
    applyWatch('orb-1', 'add', ['remote-claude'], NOW)
    const d = deps()
    const wayLater = NOW + 9 * 60 * 60_000
    expect(relayStatusToWatchers('conv-1', conv(), status(), 'working', d, wayLater)).toBeNull()
  })
})

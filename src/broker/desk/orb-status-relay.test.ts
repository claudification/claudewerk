import { beforeEach, describe, expect, it } from 'bun:test'
import type { Conversation, LiveStatus } from '../../shared/protocol'
import type { ConversationLike } from '../conversation-address'
import { relayStatusToWatchers, type StatusRelayDeps } from './orb-status-relay'
import { applyWatch, resetWatches, type WatcherSocket } from './orb-status-watch'

const NOW = 1_700_000_000_000
const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'

function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: 'conv-1', project: PROJECT, title: 'nightshift', ...over } as Conversation
}

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return { state: 'done', seq: 1, updatedAt: NOW, ...over } as LiveStatus
}

/** A capturing panel socket. `data` carries the auth slice the relay checks. */
function panel(data: unknown = {}): WatcherSocket & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return { sent, data, send: (json: string) => sent.push(JSON.parse(json)) }
}

function deps(siblings: ConversationLike[] = []): StatusRelayDeps {
  return { siblings: () => siblings, projectLabel: () => null }
}

beforeEach(() => {
  resetWatches()
})

describe('relayStatusToWatchers', () => {
  it('sends nothing when nobody is watching', () => {
    expect(relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)).toBeNull()
  })

  it('delivers to a socket watching the project', () => {
    const ws = panel()
    applyWatch(ws, 'add', ['remote-claude'])
    const r = relayStatusToWatchers('conv-1', conv(), status({ done: 'shipped it' }), 'working', deps(), NOW)

    expect(r).toEqual({ address: 'remote-claude:nightshift', matched: 1, refused: 0 })
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toMatchObject({
      type: 'voice_orb_deliver',
      kind: 'status',
      address: 'remote-claude:nightshift',
      state: 'done',
      prevState: 'working',
      body: 'shipped it',
      sourceConversationId: 'conv-1',
      sourceName: 'nightshift',
    })
  })

  it('delivers ONLY to the sockets that subscribed', () => {
    const watching = panel()
    const notWatching = panel()
    applyWatch(watching, 'add', ['remote-claude:*'])

    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)
    expect(r?.matched).toBe(1)
    expect(watching.sent).toHaveLength(1)
    expect(notWatching.sent).toHaveLength(0)
  })

  it('fans out to every matching socket', () => {
    const a = panel()
    const b = panel()
    applyWatch(a, 'add', ['remote-claude:*'])
    applyWatch(b, 'add', ['*:nightshift'])

    expect(relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)?.matched).toBe(2)
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })

  it('REFUSES a socket without chat:read on that project', () => {
    // A watch is not an authorization: the permission is re-checked at delivery.
    const guest = panel({ grants: [{ scope: 'claude://default/somewhere/else', permissions: ['chat:read'] }] })
    applyWatch(guest, 'add', ['*'])

    const r = relayStatusToWatchers('conv-1', conv(), status({ done: 'secret' }), 'working', deps(), NOW)
    expect(r).toEqual({ address: 'remote-claude:nightshift', matched: 0, refused: 1 })
    expect(guest.sent).toHaveLength(0)
  })

  it('ALLOWS a socket whose grant does cover the project', () => {
    const ok = panel({ grants: [{ scope: PROJECT, permissions: ['chat:read'] }] })
    applyWatch(ok, 'add', ['*'])
    expect(relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)?.matched).toBe(1)
    expect(ok.sent).toHaveLength(1)
  })

  it('REFUSES a per-conversation share viewer looking at a sibling', () => {
    const viewer = panel({ shareConversationId: 'some-other-conv' })
    applyWatch(viewer, 'add', ['*'])

    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)
    expect(r?.refused).toBe(1)
    expect(viewer.sent).toHaveLength(0)
  })

  it('IGNORES a seq bump that does not move the state', () => {
    const ws = panel()
    applyWatch(ws, 'add', ['remote-claude'])
    expect(relayStatusToWatchers('conv-1', conv(), status({ state: 'working' }), 'working', deps(), NOW)).toBeNull()
    expect(ws.sent).toHaveLength(0)
  })

  it('ignores a conversation with no project', () => {
    applyWatch(panel(), 'add', ['*'])
    expect(relayStatusToWatchers('conv-1', conv({ project: '' }), status(), 'working', deps(), NOW)).toBeNull()
  })

  it('picks the body that matches the state', () => {
    const cases: [Partial<LiveStatus>, string][] = [
      [{ state: 'blocked', blocked: 'build fails', pending: 'nope' }, 'build fails'],
      [{ state: 'needs_you', pending: 'pick one', blocked: 'nope' }, 'pick one'],
      [{ state: 'done', done: 'finished' }, 'finished'],
      [{ state: 'done' }, ''],
    ]
    for (const [over, expected] of cases) {
      resetWatches()
      const ws = panel()
      applyWatch(ws, 'add', ['*'])
      relayStatusToWatchers('conv-1', conv(), status(over), 'working', deps(), NOW)
      expect(ws.sent[0]?.body).toBe(expected)
    }
  })

  it('truncates a giant markdown handoff instead of speaking it whole', () => {
    const ws = panel()
    applyWatch(ws, 'add', ['*'])
    relayStatusToWatchers('conv-1', conv(), status({ done: 'x'.repeat(1000) }), 'working', deps(), NOW)
    expect((ws.sent[0]?.body as string | undefined)?.length).toBe(240)
    expect(ws.sent[0]?.body).toEndWith('…')
  })

  it('disambiguates the address when two conversations share a title', () => {
    const ws = panel()
    applyWatch(ws, 'add', ['remote-claude:*'])
    const siblings: ConversationLike[] = [
      { id: 'conv-1', project: PROJECT, title: 'nightshift' },
      { id: 'conv-2', project: PROJECT, title: 'nightshift' },
    ]
    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(siblings), NOW)
    expect(r?.address).toBe('remote-claude:nightshift-conv-1')
  })

  it('survives a socket that throws on send', () => {
    const dead: WatcherSocket = {
      data: {},
      send: () => {
        throw new Error('socket closed')
      },
    }
    const alive = panel()
    applyWatch(dead, 'add', ['*'])
    applyWatch(alive, 'add', ['*'])

    const r = relayStatusToWatchers('conv-1', conv(), status(), 'working', deps(), NOW)
    expect(r?.matched).toBe(1)
    expect(alive.sent).toHaveLength(1)
  })
})

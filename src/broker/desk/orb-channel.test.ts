import { afterEach, describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import type { UserGrant } from '../permissions'
import {
  buildOrbChannelDelivery,
  orbAudienceForConversation,
  orbSocketMayReceive,
  orbSourceName,
  parseOrbTarget,
  relayToOrb,
  relayToOrbAs,
} from './orb-channel'
import { clearQuest, registerQuest } from './quest-registry'

describe('parseOrbTarget', () => {
  test('bare orb -> all instances', () => {
    expect(parseOrbTarget('orb')).toEqual({ isOrb: true, orbId: null })
  })
  test('orb:xyz -> one instance', () => {
    expect(parseOrbTarget('orb:abc123')).toEqual({ isOrb: true, orbId: 'abc123' })
  })
  test('orb: with empty id -> treated as all', () => {
    expect(parseOrbTarget('orb:')).toEqual({ isOrb: true, orbId: null })
  })
  test('a normal conversation address is not the orb', () => {
    expect(parseOrbTarget('wandershelf:auth-refactor').isOrb).toBe(false)
    expect(parseOrbTarget('dispatcher').isOrb).toBe(false)
  })
})

describe('orbSourceName', () => {
  test('prefers title, then project label, then a short id', () => {
    expect(orbSourceName({ id: 'conv_abcdef01', title: 'auth refactor' })).toBe('auth refactor')
    expect(orbSourceName({ id: 'conv_abcdef01', title: '  ', projectLabel: 'wandershelf' })).toBe('wandershelf')
    expect(orbSourceName({ id: 'conv_abcdef0123' })).toBe('conv_abc')
  })
})

describe('buildOrbChannelDelivery', () => {
  test('wraps the body in a voice_orb_deliver envelope (all instances by default)', () => {
    const d = buildOrbChannelDelivery({ id: 'conv_x', title: 'the arr one' }, 'movies are ready', 1234)
    expect(d).toEqual({
      type: 'voice_orb_deliver',
      sourceConversationId: 'conv_x',
      sourceName: 'the arr one',
      body: 'movies are ready',
      ts: 1234,
      targetOrbId: null,
    })
  })
  test('carries the target instance id when addressed', () => {
    const d = buildOrbChannelDelivery({ id: 'c', title: 't' }, 'b', 1, 'orb-abc')
    expect(d.targetOrbId).toBe('orb-abc')
  })
})

/** Minimal store: enough for resolveSource + the scoped delivery loop. Sockets
 *  built this way carry NO `ws.data`, which `subscriberMayReceive` treats as an
 *  internal/trusted connection -- so these keep exercising the unscoped path. */
function fakeStore(opts: { conv?: { title?: string; project?: string }; panels: number }): {
  store: ConversationStore
  sent: string[]
} {
  const sent: string[] = []
  const subscribers = new Set(Array.from({ length: opts.panels }, () => ({ send: (j: string) => sent.push(j) })))
  const store = {
    getConversation: () => (opts.conv ? { title: opts.conv.title, project: opts.conv.project } : undefined),
    getSubscribers: () => subscribers,
    getSubscriberCount: () => subscribers.size,
  } as unknown as ConversationStore
  return { store, sent }
}

/** One authed control panel, with whatever `ws.data` the case needs. */
interface Panel {
  data: Record<string, unknown>
  got: string[]
}

function panel(data: Record<string, unknown>): Panel {
  const got: string[] = []
  return { data, got }
}

/** A store whose subscribers are the given panels (each keeping its own inbox),
 *  so a test can assert "user B's socket received NOTHING" rather than counting. */
function storeWithPanels(conv: { title?: string; project?: string } | undefined, panels: Panel[]): ConversationStore {
  const subscribers = new Set(panels.map(p => ({ data: p.data, send: (j: string) => p.got.push(j) })))
  return {
    getConversation: () => conv,
    getSubscribers: () => subscribers,
    getSubscriberCount: () => subscribers.size,
  } as unknown as ConversationStore
}

/** A grant giving `chat` (and therefore chat:read) on one project only. */
const chatOn = (scope: string): UserGrant[] => [{ scope, permissions: ['chat'] }]

describe('relayToOrb', () => {
  test('names the source and broadcasts to every panel (targetOrbId null = all)', () => {
    const { store, sent } = fakeStore({ conv: { title: 'deploy', project: 'claude:///infra' }, panels: 2 })
    const res = relayToOrb(store, 'conv_deploy', 'the deploy is blocked on you', null, 999)
    expect(res.ok).toBe(true)
    expect(res.subscribers).toBe(2)
    expect(res.sourceName).toBe('deploy')
    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'voice_orb_deliver',
      sourceName: 'deploy',
      body: 'the deploy is blocked on you',
      sourceConversationId: 'conv_deploy',
      targetOrbId: null,
      ts: 999,
    })
  })

  test('stamps the target instance id on the envelope', () => {
    const { store, sent } = fakeStore({ conv: { title: 'x' }, panels: 1 })
    relayToOrb(store, 'conv_x', 'just you', 'orb-9', 1)
    expect(JSON.parse(sent[0]).targetOrbId).toBe('orb-9')
  })

  test('no panels connected: ok, but subscribers=0 (message dropped, best-effort)', () => {
    const { store, sent } = fakeStore({ conv: { title: 'x' }, panels: 0 })
    const res = relayToOrb(store, 'conv_x', 'anyone there?')
    expect(res.ok).toBe(true)
    expect(res.subscribers).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test('falls back to the project label when the conversation has no title', () => {
    const { store } = fakeStore({ conv: { project: 'claude:///wandershelf' }, panels: 1 })
    const res = relayToOrb(store, 'conv_untitled', 'hi')
    expect(res.sourceName).toBe('wandershelf')
  })
})

// ─── The leak this card exists to close ────────────────────────────────
//
// Every test below FAILS against the pre-fix sink, which called
// `broadcastToSubscribers` and let the browser sort it out.

describe('orbSocketMayReceive -- the two audience rules', () => {
  test('a socket with no ws.data at all passes (internal/trusted connection)', () => {
    expect(orbSocketMayReceive({}, { userId: null, project: 'claude:///infra' })).toBe(true)
  })

  test('user rule: a different authed user is refused, the named one passes', () => {
    expect(orbSocketMayReceive({ userName: 'mira' }, { userId: 'jonas' })).toBe(false)
    expect(orbSocketMayReceive({ userName: 'jonas' }, { userId: 'jonas' })).toBe(true)
  })

  test('a null/absent userId does not narrow by user', () => {
    expect(orbSocketMayReceive({ userName: 'mira' }, { userId: null })).toBe(true)
    expect(orbSocketMayReceive({ userName: 'mira' }, {})).toBe(true)
  })

  test('permission rule: no chat:read on the source project -> refused', () => {
    const data = { grants: chatOn('claude:///other') }
    expect(orbSocketMayReceive(data, { project: 'claude:///infra' })).toBe(false)
    expect(orbSocketMayReceive(data, { project: 'claude:///other' })).toBe(true)
  })

  test('a conversation-scoped share guest never hears a SIBLING conversation', () => {
    const guest = { shareConversationId: 'conv_shared' }
    expect(orbSocketMayReceive(guest, { project: 'claude:///infra', conversationId: 'conv_secret' })).toBe(false)
    expect(orbSocketMayReceive(guest, { project: 'claude:///infra', conversationId: 'conv_shared' })).toBe(true)
  })
})

describe('orbAudienceForConversation', () => {
  afterEach(() => clearQuest('conv_worker'))

  const infraConv = { title: 'x', project: 'claude:///infra' }

  test('carries the source project + id, and no user for an unowned conversation', () => {
    expect(orbAudienceForConversation(infraConv, 'conv_plain')).toEqual({
      userId: null,
      project: 'claude:///infra',
      conversationId: 'conv_plain',
    })
  })

  test('a dispatched quest worker inherits the userId of the dispatcher that spawned it', () => {
    registerQuest('conv_worker', { userId: 'jonas', pendingId: 'q1', intent: 'find the thing' })
    expect(orbAudienceForConversation(infraConv, 'conv_worker').userId).toBe('jonas')
  })

  test('resolving the audience does NOT consume the quest link (report-back still needs it)', () => {
    registerQuest('conv_worker', { userId: 'jonas', pendingId: 'q1', intent: 'find the thing' })
    orbAudienceForConversation(infraConv, 'conv_worker')
    expect(orbAudienceForConversation(infraConv, 'conv_worker').userId).toBe('jonas')
  })
})

describe('relayToOrb -- a line never lands on a socket it was not addressed to', () => {
  afterEach(() => clearQuest('conv_worker'))

  test("THE CARD'S TEST: two users, one orb send -- the other user's socket receives NOTHING", () => {
    registerQuest('conv_worker', { userId: 'jonas', pendingId: 'q1', intent: 'deploy check' })
    const mine = panel({ userName: 'jonas' })
    const theirs = panel({ userName: 'mira' })
    const store = storeWithPanels({ title: 'deploy', project: 'claude:///infra' }, [mine, theirs])

    const res = relayToOrb(store, 'conv_worker', 'the prod key is rotating at 4pm', null, 7)

    expect(theirs.got).toEqual([])
    expect(mine.got).toHaveLength(1)
    expect(JSON.parse(mine.got[0])).toMatchObject({ body: 'the prod key is rotating at 4pm' })
    expect(res).toMatchObject({ ok: true, subscribers: 1, refused: 1 })
  })

  test('a second operator with no chat:read on the project hears nothing, even unowned', () => {
    const insider = panel({ userName: 'jonas', grants: chatOn('claude:///infra') })
    const outsider = panel({ userName: 'mira', grants: chatOn('claude:///marketing') })
    const store = storeWithPanels({ title: 'deploy', project: 'claude:///infra' }, [insider, outsider])

    const res = relayToOrb(store, 'conv_plain', 'staging is down', null, 7)

    expect(outsider.got).toEqual([])
    expect(insider.got).toHaveLength(1)
    expect(res).toMatchObject({ subscribers: 1, refused: 1 })
  })

  test('a share guest scoped to another conversation hears nothing', () => {
    const guest = panel({ isShare: true, shareConversationId: 'conv_public' })
    const store = storeWithPanels({ title: 'private', project: 'claude:///infra' }, [guest])

    const res = relayToOrb(store, 'conv_private', 'the token is in .env.local', null, 7)

    expect(guest.got).toEqual([])
    expect(res).toMatchObject({ subscribers: 0, refused: 1 })
  })

  test('the same guest DOES hear the conversation its share is scoped to', () => {
    const guest = panel({ isShare: true, shareConversationId: 'conv_public' })
    const store = storeWithPanels({ title: 'public', project: 'claude:///infra' }, [guest])

    expect(relayToOrb(store, 'conv_public', 'build is green', null, 7).subscribers).toBe(1)
    expect(guest.got).toHaveLength(1)
  })

  test('a dead socket is skipped without taking the delivery down with it', () => {
    const live = panel({ userName: 'jonas' })
    const subscribers = new Set<{ data: unknown; send: (j: string) => void }>([
      {
        data: { userName: 'jonas' },
        send: () => {
          throw new Error('socket closed')
        },
      },
      { data: live.data, send: (j: string) => live.got.push(j) },
    ])
    const store = {
      getConversation: () => ({ title: 't', project: 'claude:///infra' }),
      getSubscribers: () => subscribers,
      getSubscriberCount: () => subscribers.size,
    } as unknown as ConversationStore

    expect(relayToOrb(store, 'conv_plain', 'still here', null, 7).subscribers).toBe(1)
    expect(live.got).toHaveLength(1)
  })
})

describe('relayToOrbAs -- the dispatcher speaks to ONE user', () => {
  test("a quest answer for user A is not delivered to user B's panel", () => {
    const a = panel({ userName: 'jonas' })
    const b = panel({ userName: 'mira' })
    const store = storeWithPanels(undefined, [a, b])

    const res = relayToOrbAs(store, 'your dispatcher', 'three releases this week', null, 'jonas', 5)

    expect(b.got).toEqual([])
    expect(JSON.parse(a.got[0])).toMatchObject({ sourceName: 'your dispatcher', body: 'three releases this week' })
    expect(res).toMatchObject({ subscribers: 1, refused: 1 })
  })

  test('an anonymous dispatcher (no user) still reaches every panel -- unchanged behaviour', () => {
    const a = panel({ userName: 'jonas' })
    const b = panel({ userName: 'mira' })
    const store = storeWithPanels(undefined, [a, b])

    expect(relayToOrbAs(store, 'your dispatcher', 'hi', null, null, 5).subscribers).toBe(2)
  })
})

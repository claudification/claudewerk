/**
 * PROVE-OR-KILL: does an inter-conversation link approval survive a broker restart?
 *
 * `werk-multi-operator` claimed "link-approval ALLOW is not persisted across broker
 * restarts -- it lives for broker lifetime only". This file is the executable refutation:
 * it drives the REAL handlers (`channel_link_response` approve, `channel_link_grant`) and
 * the REAL persistence modules (project-links.ts, conversation-links.ts) through a
 * simulated broker restart, then re-runs the REAL send path (`channel_send`) and asserts
 * the message is delivered without a second approval prompt.
 *
 * "Restart" is modelled exactly as index.ts boots: throw away the in-memory
 * `createProjectLinkRegistry` (a plain Set -- it genuinely does NOT survive) and re-run
 * `initProjectLinks` / `initConversationLinks` against the SAME KV. The KV mock
 * JSON-round-trips on set/get so nothing survives by shared object reference.
 *
 * Both authorization tiers are covered, because they persist through different stores:
 *   - project tier  -- the approval banner   -> kv['project-links']      (rule 5)
 *   - conversation tier -- the `:` ad-hoc grant -> kv['conversation-links'] (rule 3)
 *
 * The negative control ("never approved -> still queues after restart") is what makes the
 * positives meaningful: it proves this harness can still observe the re-prompt it claims
 * is absent.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import {
  addPersistedConvLink,
  findConvLink,
  initConversationLinks,
  removePersistedConvLink,
  touchConvLink,
} from '../conversation-links'
import { createProjectLinkRegistry } from '../conversation-store/project-links'
import type { HandlerContext } from '../handler-context'
import { channelLinkGrant, channelLinkResponse, channelSend } from '../handlers/channel'
import {
  addPersistedLink,
  findLink,
  getPersistedLinks,
  initProjectLinks,
  removePersistedLink,
  touchLink,
} from '../project-links'
import type { KVStore } from '../store/types'

const PROJECT_A = 'claude://default/Users/jonas/projects/alpha'
const PROJECT_B = 'claude://default/Users/jonas/projects/beta'
const CONV_A = 'conv-aaaaaaaa-0000-0000-0000-000000000001'
const CONV_B = 'conv-bbbbbbbb-0000-0000-0000-000000000002'

/** KV mock that serializes like the SQLite KV does, so a "restart" cannot cheat
 *  by handing the module back the very array it was holding before. */
function makeKv(seed?: Record<string, unknown>): KVStore {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(seed ?? {})) map.set(k, JSON.stringify(v))
  return {
    get: <T>(key: string) => (map.has(key) ? (JSON.parse(map.get(key) as string) as T) : null),
    set: (key, value) => {
      map.set(key, JSON.stringify(value))
    },
    delete: (key: string) => map.delete(key),
    keys: (prefix?: string) => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
  }
}

interface Broker {
  ctx: HandlerContext
  /** Everything the target conversation's socket received. */
  delivered: Record<string, unknown>[]
  /** Replies sent back to the sender (channel_send_result). */
  replies: Record<string, unknown>[]
  /** ctx.broadcast payloads -- a `channel_link_request` here IS the approval prompt. */
  broadcasts: Record<string, unknown>[]
}

/**
 * Boot a broker: fresh in-memory link registry (the volatile tier) wired to the
 * module-level persisted stores re-initialized from `kv` (the durable tier). Call
 * twice with the same `kv` to model a restart.
 */
function bootBroker(kv: KVStore): Broker {
  initProjectLinks(kv)
  initConversationLinks(kv)

  const conversations = new Map<string, Conversation>([
    [CONV_A, { id: CONV_A, project: PROJECT_A, title: 'Alpha' } as Conversation],
    [CONV_B, { id: CONV_B, project: PROJECT_B, title: 'Bravo' } as Conversation],
  ])
  const registry = createProjectLinkRegistry(conversations, new Map())

  const delivered: Record<string, unknown>[] = []
  const replies: Record<string, unknown>[] = []
  const broadcasts: Record<string, unknown>[] = []
  const targetSocket = { send: (json: string) => delivered.push(JSON.parse(json)) }

  const ctx = {
    ws: { data: { conversationId: CONV_A } },
    caller: { project: PROJECT_A },
    conversations: {
      ...registry,
      getConversation: (id: string) => conversations.get(id),
      findConversationByConversationId: (id: string) => conversations.get(id),
      getAllConversations: () => conversations.values(),
      getActiveConversations: () => Array.from(conversations.values()),
      getActiveConversationCount: () => 1,
      getConversationSocket: (id: string) => (id === CONV_B ? targetSocket : undefined),
      registerImpulse: () => {},
      persistConversationById: () => {},
      broadcastConversationUpdate: () => {},
      broadcastConversationScoped: () => {},
      broadcastForProject: () => {},
    },
    links: {
      find: (a: string, b: string) => !!findLink(a, b),
      add: addPersistedLink,
      remove: removePersistedLink,
      touch: touchLink,
    },
    convLinks: {
      find: (a: string, b: string) => !!findConvLink(a, b),
      add: addPersistedConvLink,
      remove: removePersistedConvLink,
      touch: touchConvLink,
    },
    // No address book entries: send addresses the target by raw conversation id.
    addressBook: { getOrAssign: () => 'alpha', resolve: () => undefined },
    messageQueue: { enqueue: () => {}, drain: () => [], getQueueSize: () => 0 },
    getProjectSettings: () => null,
    requirePermission: () => {},
    reply: (msg: Record<string, unknown>) => replies.push(msg),
    broadcast: (msg: Record<string, unknown>) => broadcasts.push(msg),
    logMessage: () => {},
    // `warn` is not optional: channelLinkResponse's empty-pending-drain path calls it
    // (werk-link-pending-queue-volatile). A mock missing a method its target declares is
    // the partial-mock class of bug -- see scripts/check-partial-module-mocks.ts.
    log: { info() {}, error() {}, debug() {}, warn() {} },
  } as unknown as HandlerContext

  return { ctx, delivered, replies, broadcasts }
}

/** Send A -> B through the real handler and report what the sender was told. */
function send(broker: Broker, message = 'ping'): { status?: string; ok?: boolean } {
  channelSend(broker.ctx, { fromConversation: CONV_A, toConversation: CONV_B, intent: 'notify', message })
  const reply = broker.replies.at(-1) ?? {}
  return { status: reply.status as string | undefined, ok: reply.ok as boolean | undefined }
}

/** Did the panel get an approval banner for this send? */
function prompted(broker: Broker): boolean {
  return broker.broadcasts.some(b => b.type === 'channel_link_request')
}

describe('link approval durability across a broker restart', () => {
  let kv: KVStore

  beforeEach(() => {
    kv = makeKv()
  })

  it('an un-approved pair queues and raises an approval prompt (negative control)', () => {
    const broker = bootBroker(kv)
    expect(send(broker)).toEqual({ status: 'queued', ok: true })
    expect(prompted(broker)).toBe(true)
    expect(broker.delivered).toHaveLength(0)
  })

  it('PROJECT tier: approve -> restart -> still delivers, no second prompt', () => {
    const first = bootBroker(kv)
    expect(send(first).status).toBe('queued')

    channelLinkResponse(first.ctx, { fromConversation: CONV_A, toConversation: CONV_B, action: 'approve' })
    expect(getPersistedLinks()).toHaveLength(1)
    expect(send(first).status).toBe('delivered')

    // Restart. The in-memory registry is genuinely empty again...
    const after = bootBroker(kv)
    expect(after.ctx.conversations.checkProjectLink(CONV_A, CONV_B)).toBe('unknown')
    // ...but the persisted approval still authorizes the send.
    expect(send(after, 'after restart')).toEqual({ status: 'delivered', ok: true })
    expect(prompted(after)).toBe(false)
    expect(after.delivered.at(-1)).toMatchObject({ type: 'channel_deliver', message: 'after restart' })
  })

  it('CONVERSATION tier: `:` grant -> restart -> still delivers, no second prompt', () => {
    const first = bootBroker(kv)
    channelLinkGrant(first.ctx, { fromConversation: CONV_A, toConversation: CONV_B })
    expect(findConvLink(CONV_A, CONV_B)).not.toBeNull()
    // A conv grant must NOT have widened into a project-wide link.
    expect(getPersistedLinks()).toHaveLength(0)

    const after = bootBroker(kv)
    expect(after.ctx.conversations.checkConvLink(CONV_A, CONV_B)).toBe('unknown')
    expect(send(after, 'after restart')).toEqual({ status: 'delivered', ok: true })
    expect(prompted(after)).toBe(false)
  })

  it('a restart re-caches the persisted approval into the in-memory registry on first use', () => {
    const first = bootBroker(kv)
    channelLinkResponse(first.ctx, { fromConversation: CONV_A, toConversation: CONV_B, action: 'approve' })

    const after = bootBroker(kv)
    send(after)
    // Second send is now authorized by the live tier (rule 2), not the store lookup.
    expect(after.ctx.conversations.checkProjectLink(CONV_A, CONV_B)).toBe('linked')
  })

  it('BLOCK also survives the restart: the persisted row is gone, so the pair re-prompts', () => {
    const first = bootBroker(kv)
    channelLinkResponse(first.ctx, { fromConversation: CONV_A, toConversation: CONV_B, action: 'approve' })
    channelLinkResponse(first.ctx, { fromConversation: CONV_A, toConversation: CONV_B, action: 'block' })
    expect(getPersistedLinks()).toHaveLength(0)

    const after = bootBroker(kv)
    expect(send(after).status).toBe('queued')
    expect(prompted(after)).toBe(true)
  })

  it('the ONLY thing that expires an approval is the 90-day unused eviction', () => {
    const stale = Date.now() - 91 * 24 * 60 * 60 * 1000
    const staleKv = makeKv({
      'project-links': [{ projectA: PROJECT_A, projectB: PROJECT_B, createdAt: stale, lastUsed: stale }],
    })
    const after = bootBroker(staleKv)
    expect(send(after).status).toBe('queued')

    const fresh = Date.now() - 89 * 24 * 60 * 60 * 1000
    const freshKv = makeKv({
      'project-links': [{ projectA: PROJECT_A, projectB: PROJECT_B, createdAt: fresh, lastUsed: fresh }],
    })
    expect(send(bootBroker(freshKv)).status).toBe('delivered')
  })
})

/**
 * Tests for the channel_link_grant handler -- the ad-hoc, on-send authorization
 * created when a message references another conversation via the `:` completer's
 * <conversation> token.
 *
 * Rules under test:
 *   - new link  -> linkProjects + persist (links.add) + broadcast channel_link_granted
 *   - already linked -> no-op (no broadcast, no re-add) so resends don't re-toast
 *   - blocked   -> no-op (respect the block)
 *   - self ref  -> ignored
 *   - missing project on either side -> skipped
 *   - settings permission required on both projects
 */

import { describe, expect, it } from 'bun:test'
import { GuardError, type HandlerContext } from '../handler-context'
import { channelLinkGrant } from './channel'

interface MockConversation {
  id: string
  project: string
}

interface Recorder {
  linked: Array<[string, string]>
  persisted: Array<[string, string]>
  broadcasts: Record<string, unknown>[]
  updates: string[]
}

function makeCtx(
  conversations: MockConversation[],
  opts: {
    linkStatus?: 'linked' | 'blocked' | 'unknown'
    permissionThrows?: boolean
    projectLabel?: string
  } = {},
): { ctx: HandlerContext; rec: Recorder } {
  const rec: Recorder = { linked: [], persisted: [], broadcasts: [], updates: [] }
  const byId = (id: string) => conversations.find(c => c.id === id)
  const ctx = {
    conversations: {
      getConversation: (id: string) => byId(id),
      checkProjectLink: () => opts.linkStatus ?? 'unknown',
      linkProjects: (a: string, b: string) => rec.linked.push([a, b]),
      drainProjectMessages: () => [],
      getConversationSocket: () => undefined,
      broadcastConversationUpdate: (id: string) => rec.updates.push(id),
    },
    links: {
      add: (a: string, b: string) => rec.persisted.push([a, b]),
      find: () => false,
      remove: () => {},
      touch: () => {},
    },
    getProjectSettings: () => (opts.projectLabel ? { label: opts.projectLabel } : null),
    requirePermission: () => {
      if (opts.permissionThrows) throw new GuardError('Permission denied')
    },
    broadcast: (msg: Record<string, unknown>) => rec.broadcasts.push(msg),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, rec }
}

const A: MockConversation = { id: 'conv_a', project: 'claude:///proj-a' }
const B: MockConversation = { id: 'conv_b', project: 'claude:///proj-b' }

describe('channel_link_grant', () => {
  it('grants + persists + broadcasts a new link', () => {
    const { ctx, rec } = makeCtx([A, B], { linkStatus: 'unknown', projectLabel: 'Proj B' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.linked).toEqual([['conv_a', 'conv_b']])
    expect(rec.persisted).toEqual([['claude:///proj-a', 'claude:///proj-b']])
    expect(rec.broadcasts).toHaveLength(1)
    expect(rec.broadcasts[0]).toMatchObject({
      type: 'channel_link_granted',
      fromConversation: 'conv_a',
      toConversation: 'conv_b',
      toProject: 'claude:///proj-b',
      toProjectLabel: 'Proj B',
    })
    expect(rec.updates).toEqual(['conv_a', 'conv_b'])
  })

  it('is a no-op when already linked (no re-toast on resend)', () => {
    const { ctx, rec } = makeCtx([A, B], { linkStatus: 'linked' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.linked).toEqual([])
    expect(rec.persisted).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('is a no-op when blocked', () => {
    const { ctx, rec } = makeCtx([A, B], { linkStatus: 'blocked' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.linked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('ignores a self-reference', () => {
    const { ctx, rec } = makeCtx([A], { linkStatus: 'unknown' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_a' })
    expect(rec.linked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('skips when the target conversation is unknown', () => {
    const { ctx, rec } = makeCtx([A], { linkStatus: 'unknown' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_missing' })
    expect(rec.linked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('enforces settings permission (throws -> no grant)', () => {
    const { ctx, rec } = makeCtx([A, B], { linkStatus: 'unknown', permissionThrows: true })
    expect(() => channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })).toThrow(GuardError)
    expect(rec.linked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })
})

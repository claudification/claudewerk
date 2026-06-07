/**
 * Tests for the channel_link_grant handler -- the ad-hoc, on-send authorization
 * created when a message references another conversation via the `:` completer's
 * <conversation> token.
 *
 * The grant is CONVERSATION-scoped: it links exactly the two referenced conversations,
 * NOT their projects. Rules under test:
 *   - new link  -> linkConversations + persist (convLinks.add) + broadcast (scope:conversation)
 *   - already conv-linked -> no-op (no broadcast) so resends don't re-toast
 *   - already project-linked OR project-blocked -> no-op (respect the existing decision)
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
  title?: string
}

interface Recorder {
  convLinked: Array<[string, string]>
  convPersisted: Array<[string, string]>
  projectLinked: Array<[string, string]>
  broadcasts: Record<string, unknown>[]
  updates: string[]
}

function makeCtx(
  conversations: MockConversation[],
  opts: {
    convStatus?: 'linked' | 'unknown'
    projectStatus?: 'linked' | 'blocked' | 'unknown'
    permissionThrows?: boolean
    projectLabel?: string
  } = {},
): { ctx: HandlerContext; rec: Recorder } {
  const rec: Recorder = { convLinked: [], convPersisted: [], projectLinked: [], broadcasts: [], updates: [] }
  const byId = (id: string) => conversations.find(c => c.id === id)
  const ctx = {
    conversations: {
      getConversation: (id: string) => byId(id),
      checkConvLink: () => opts.convStatus ?? 'unknown',
      checkProjectLink: () => opts.projectStatus ?? 'unknown',
      linkConversations: (a: string, b: string) => rec.convLinked.push([a, b]),
      linkProjects: (a: string, b: string) => rec.projectLinked.push([a, b]),
      drainProjectMessages: () => [],
      getConversationSocket: () => undefined,
      broadcastConversationUpdate: (id: string) => rec.updates.push(id),
    },
    convLinks: {
      add: (a: string, b: string) => rec.convPersisted.push([a, b]),
      find: () => false,
      remove: () => {},
      touch: () => {},
    },
    links: { add: () => {}, find: () => false, remove: () => {}, touch: () => {} },
    getProjectSettings: () => (opts.projectLabel ? { label: opts.projectLabel } : null),
    requirePermission: () => {
      if (opts.permissionThrows) throw new GuardError('Permission denied')
    },
    broadcast: (msg: Record<string, unknown>) => rec.broadcasts.push(msg),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, rec }
}

const A: MockConversation = { id: 'conv_a', project: 'claude:///proj-a', title: 'Alpha' }
const B: MockConversation = { id: 'conv_b', project: 'claude:///proj-b', title: 'Bravo' }

describe('channel_link_grant', () => {
  it('grants + persists + broadcasts a new CONVERSATION-scoped link', () => {
    const { ctx, rec } = makeCtx([A, B], { projectLabel: 'Proj B' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    // Linked at conversation granularity, NOT project.
    expect(rec.convLinked).toEqual([['conv_a', 'conv_b']])
    expect(rec.convPersisted).toEqual([['conv_a', 'conv_b']])
    expect(rec.projectLinked).toEqual([])
    expect(rec.broadcasts).toHaveLength(1)
    expect(rec.broadcasts[0]).toMatchObject({
      type: 'channel_link_granted',
      scope: 'conversation',
      fromConversation: 'conv_a',
      toConversation: 'conv_b',
      // Label is the target conversation's title for conv-scoped grants.
      toProjectLabel: 'Bravo',
    })
    expect(rec.updates).toEqual(['conv_a', 'conv_b'])
  })

  it('is a no-op when already conv-linked (no re-toast on resend)', () => {
    const { ctx, rec } = makeCtx([A, B], { convStatus: 'linked' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.convLinked).toEqual([])
    expect(rec.convPersisted).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('is a no-op when the projects are already linked (project link already authorizes)', () => {
    const { ctx, rec } = makeCtx([A, B], { projectStatus: 'linked' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.convLinked).toEqual([])
    expect(rec.convPersisted).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('is a no-op when the projects are blocked', () => {
    const { ctx, rec } = makeCtx([A, B], { projectStatus: 'blocked' })
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })
    expect(rec.convLinked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('ignores a self-reference', () => {
    const { ctx, rec } = makeCtx([A])
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_a' })
    expect(rec.convLinked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('skips when the target conversation is unknown', () => {
    const { ctx, rec } = makeCtx([A])
    channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_missing' })
    expect(rec.convLinked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })

  it('enforces settings permission (throws -> no grant)', () => {
    const { ctx, rec } = makeCtx([A, B], { permissionThrows: true })
    expect(() => channelLinkGrant(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b' })).toThrow(GuardError)
    expect(rec.convLinked).toEqual([])
    expect(rec.broadcasts).toEqual([])
  })
})

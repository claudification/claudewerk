/**
 * Tests for the conversation-scoped methods on the in-memory link registry:
 * checkConvLink / linkConversations / unlinkConversations / getLinkedConversations.
 * These are the live cache consulted on the send path; the persisted source of truth
 * lives in conversation-links.ts.
 */

import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { Conversation } from '../../shared/protocol'
import { createProjectLinkRegistry } from './project-links'

function makeRegistry(convs: Array<Partial<Conversation> & { id: string }>) {
  const conversations = new Map<string, Conversation>()
  for (const c of convs) conversations.set(c.id, c as Conversation)
  const sockets = new Map<string, Map<string, ServerWebSocket<unknown>>>()
  return createProjectLinkRegistry(conversations, sockets)
}

const A = { id: 'conv_a', project: 'claude:///a', title: 'Alpha' }
const B = { id: 'conv_b', project: 'claude:///b', title: 'Bravo' }

describe('conv-link registry methods', () => {
  it('checkConvLink reflects link/unlink, order-independent', () => {
    const reg = makeRegistry([A, B])
    expect(reg.checkConvLink('conv_a', 'conv_b')).toBe('unknown')
    reg.linkConversations('conv_a', 'conv_b')
    expect(reg.checkConvLink('conv_a', 'conv_b')).toBe('linked')
    expect(reg.checkConvLink('conv_b', 'conv_a')).toBe('linked')
    reg.unlinkConversations('conv_b', 'conv_a')
    expect(reg.checkConvLink('conv_a', 'conv_b')).toBe('unknown')
  })

  it('ignores self-links', () => {
    const reg = makeRegistry([A])
    reg.linkConversations('conv_a', 'conv_a')
    expect(reg.checkConvLink('conv_a', 'conv_a')).toBe('unknown')
  })

  it('getLinkedConversations returns the OTHER side with its title', () => {
    const reg = makeRegistry([A, B])
    reg.linkConversations('conv_a', 'conv_b')
    expect(reg.getLinkedConversations('conv_a')).toEqual([{ conversationId: 'conv_b', name: 'Bravo' }])
    expect(reg.getLinkedConversations('conv_b')).toEqual([{ conversationId: 'conv_a', name: 'Alpha' }])
    expect(reg.getLinkedConversations('conv_z')).toEqual([])
  })

  it('falls back to a short id when the linked conversation has no title', () => {
    const reg = makeRegistry([A, { id: 'conv_notitle', project: 'claude:///c' }])
    reg.linkConversations('conv_a', 'conv_notitle')
    expect(reg.getLinkedConversations('conv_a')).toEqual([{ conversationId: 'conv_notitle', name: 'conv_not' }])
  })

  it('conv links are independent of project links', () => {
    const reg = makeRegistry([A, B])
    reg.linkConversations('conv_a', 'conv_b')
    // A conv link must NOT register as a project link.
    expect(reg.checkProjectLink('conv_a', 'conv_b')).toBe('unknown')
    expect(reg.getLinkedProjects('conv_a')).toEqual([])
  })
})

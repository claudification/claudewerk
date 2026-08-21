/**
 * channel_link_response: the empty-drain warning.
 *
 * An approve against a pair whose status was `unknown` means the human was looking
 * at a channel_link_request banner, which means a first-contact message SHOULD be
 * waiting. An empty drain there is a silent message loss and must be logged loudly.
 *
 * It is deliberately NOT a generic warn-on-empty: `channelLinkGrant` and the admin
 * route drain speculatively, and re-approving an already-linked pair is normal, so
 * those must stay quiet.
 */

import { describe, expect, it } from 'bun:test'
import type { HandlerContext } from '../handler-context'
import { channelLinkResponse } from './channel'

interface Recorder {
  warns: string[]
  drained: number
}

function makeCtx(opts: {
  projectStatus?: 'linked' | 'blocked' | 'unknown'
  queued?: Record<string, unknown>[]
  action?: string
}): { ctx: HandlerContext; rec: Recorder } {
  const rec: Recorder = { warns: [], drained: 0 }
  const conversations = {
    conv_a: { id: 'conv_a', project: 'claude://default/proj-a' },
    conv_b: { id: 'conv_b', project: 'claude://default/proj-b' },
  } as Record<string, { id: string; project: string }>

  const ctx = {
    ws: { data: { isControlPanel: true } },
    caller: undefined,
    conversations: {
      getConversation: (id: string) => conversations[id],
      checkProjectLink: () => opts.projectStatus ?? 'unknown',
      linkProjects: () => {},
      blockProject: () => {},
      drainProjectMessages: () => {
        rec.drained++
        return opts.queued ?? []
      },
      getConversationSocket: () => undefined,
    },
    links: { add: () => {}, find: () => false, remove: () => {}, touch: () => {} },
    requirePermission: () => {},
    reply: () => {},
    log: {
      info() {},
      warn: (msg: string) => rec.warns.push(msg),
      error() {},
      debug() {},
    },
  } as unknown as HandlerContext
  return { ctx, rec }
}

const APPROVE = { fromConversation: 'conv_a', toConversation: 'conv_b', action: 'approve' }

describe('channel_link_response empty-drain warning', () => {
  it('WARNS when an approve against an unknown pair drains nothing', () => {
    const { ctx, rec } = makeCtx({ projectStatus: 'unknown', queued: [] })
    channelLinkResponse(ctx, { ...APPROVE })

    expect(rec.drained).toBe(1)
    expect(rec.warns).toHaveLength(1)
    // Full context, never a bare "0 drained": both conversations, both project URIs,
    // and the approver.
    const warn = rec.warns[0]
    expect(warn).toContain('conv_a')
    expect(warn).toContain('conv_b')
    expect(warn).toContain('claude://default/proj-a')
    expect(warn).toContain('claude://default/proj-b')
    expect(warn).toContain('approver=control-panel')
    expect(warn).toContain('EMPTY')
  })

  it('stays QUIET when the approve actually delivers a queued message', () => {
    const { ctx, rec } = makeCtx({ projectStatus: 'unknown', queued: [{ type: 'channel_deliver' }] })
    channelLinkResponse(ctx, { ...APPROVE })
    expect(rec.warns).toEqual([])
  })

  it('stays QUIET re-approving an already-linked pair (empty is normal there)', () => {
    const { ctx, rec } = makeCtx({ projectStatus: 'linked', queued: [] })
    channelLinkResponse(ctx, { ...APPROVE })
    expect(rec.drained).toBe(1)
    expect(rec.warns).toEqual([])
  })

  it('stays QUIET on a BLOCK with nothing queued', () => {
    const { ctx, rec } = makeCtx({ projectStatus: 'unknown', queued: [] })
    channelLinkResponse(ctx, { fromConversation: 'conv_a', toConversation: 'conv_b', action: 'block' })
    expect(rec.warns).toEqual([])
  })

  it('names the caller conversation as the approver when there is one', () => {
    const { ctx, rec } = makeCtx({ projectStatus: 'unknown', queued: [] })
    ;(ctx as { caller?: { id: string } }).caller = { id: 'conv_operator' }
    channelLinkResponse(ctx, { ...APPROVE })
    expect(rec.warns[0]).toContain('approver=conv_operator')
  })
})

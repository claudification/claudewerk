import { describe, expect, it } from 'bun:test'
import type { Conversation, HookEvent, HookEventType } from '../../shared/protocol'
import { addEvent } from './add-event'
import { makeTestContext } from './test-context'

/**
 * `lastActivity` must mean WORK HAPPENED, because half the broker reads it that
 * way: the reaper's liveness check, the stale-agent sweep, ENDED eviction, the
 * conversation-list sort, recency in the sheaf and the desk, and Pulse's bands.
 *
 * THE BUG (2026-08-19): every hook event stamped it, teardown included. Jonas
 * closed three conversations that had finished on Aug 14, 16 and 17; `SessionEnd`
 * stamped each one on the way out and all three surfaced as though they had just
 * finished. A conversation dying is not a conversation working.
 */
const OLD = 1_600_000_000_000

function makeConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_parent',
    project: 'claude://x/y',
    status: 'active',
    lastActivity: OLD,
    events: [],
    subagents: [],
    teammates: [],
    stats: { toolCallCount: 0 },
    ...over,
  } as unknown as Conversation
}

function ctxFor(conv: Conversation) {
  return makeTestContext({ conversations: new Map([[conv.id, conv]]) })
}

function hook(hookEvent: HookEventType, data: Record<string, unknown> = {}): HookEvent {
  return {
    type: 'hook',
    conversationId: 'conv_parent',
    hookEvent,
    timestamp: 1,
    data: { session_id: 'p', ...data },
  } as HookEvent
}

describe('lastActivity stamping', () => {
  it('does NOT stamp on SessionEnd — dying is not working', () => {
    // The exact repro: a conversation whose real last work was days ago, closed
    // from the dashboard context menu. `terminate forwarded` -> `SessionEnd` ->
    // the stamp made the close look like the finish.
    const conv = makeConv({ lastActivity: OLD })
    addEvent(ctxFor(conv), conv.id, hook('SessionEnd'))
    expect(conv.lastActivity).toBe(OLD)
  })

  it('does NOT stamp on a system-generated away_summary recap', () => {
    // Same class, already half-recognised in add-event.ts: the recap path is
    // explicitly "system-generated, not real user activity" for the status flip,
    // yet it stamped anyway -- so a background recap made a dormant conversation
    // look fresh on every recency surface.
    const conv = makeConv({ lastActivity: OLD })
    const event = hook('Stop')
    ;(event.data as Record<string, unknown>).input = {
      type: 'system',
      subtype: 'away_summary',
      content: 'a recap',
    }
    addEvent(ctxFor(conv), conv.id, event)
    expect(conv.lastActivity).toBe(OLD)
  })

  it('DOES stamp on Stop — a finished turn is real work', () => {
    // Stop is in PASSIVE_HOOKS, but passive there means "do not flip status to
    // active": the turn just ENDED. It is still genuine activity, and dropping
    // its stamp would age a working conversation past the reaper's liveness and
    // stale-agent checks.
    const conv = makeConv({ lastActivity: OLD })
    addEvent(ctxFor(conv), conv.id, hook('Stop'))
    expect(conv.lastActivity).toBeGreaterThan(OLD)
  })

  it('DOES stamp on ordinary tool work', () => {
    const conv = makeConv({ lastActivity: OLD })
    addEvent(ctxFor(conv), conv.id, hook('PreToolUse', { tool_name: 'Read' }))
    expect(conv.lastActivity).toBeGreaterThan(OLD)
  })

  it('DOES stamp on SessionStart — a revive is a real event', () => {
    // Deliberately NOT teardown. Reviving a conversation is something that
    // genuinely just happened to it, and the recency surfaces should say so.
    const conv = makeConv({ lastActivity: OLD })
    addEvent(ctxFor(conv), conv.id, hook('SessionStart', { model: 'claude-opus-5' }))
    expect(conv.lastActivity).toBeGreaterThan(OLD)
  })
})

/**
 * The channel-delivery envelope: what a conversation actually receives.
 *
 * The point of these is DRIFT. The same delivery has to reach a headless agent
 * (as `<channel ...>` attributes) and a PTY agent (as MCP channel meta), and a
 * field that lands in one but not the other is a bug you only notice when an
 * agent silently cannot tell which canvas it is looking at. So every case here
 * asserts both shapes.
 */

import { expect, test } from 'bun:test'
import type { CanvasSelection } from '../shared/canvas-selection'
import type { InterConversationDelivery } from '../shared/protocol'
import { channelAttrs, channelMeta, deliveryBody } from './broker-connection'

function delivery(over: Partial<InterConversationDelivery> = {}): InterConversationDelivery {
  return {
    type: 'channel_deliver',
    fromConversation: 'rclaude:fuzzy-rabbit',
    fromProject: 'rclaude',
    intent: 'request',
    message: 'hello',
    ...over,
  }
}

const selection: CanvasSelection = {
  count: 2,
  elements: [
    { id: 'a', type: 'rectangle', text: 'Login' },
    { id: 'b', type: 'ellipse' },
  ],
  truncated: false,
}

test('a plain peer message carries no canvas fields in either transport', () => {
  const d = delivery()
  expect(channelAttrs(d, 'conversation')).not.toContain('canvas_id')
  expect(channelMeta(d, 'conversation').canvas_id).toBeUndefined()
  expect(deliveryBody(d)).toBe('hello')
})

test('canvas_id reaches BOTH transports', () => {
  const d = delivery({ canvasId: 'cnv_123', sender: 'canvas', source: 'rclaude' })
  expect(channelAttrs(d, 'canvas')).toContain('canvas_id="cnv_123"')
  expect(channelMeta(d, 'canvas').canvas_id).toBe('cnv_123')
})

test('a canvas line is marked as the USER, not an untrusted peer', () => {
  // source="rclaude" is what tells the agent to ACT on it. Losing this would
  // silently downgrade the user's own typing to peer input.
  const d = delivery({ canvasId: 'cnv_123', sender: 'canvas', source: 'rclaude' })
  const attrs = channelAttrs(d, 'canvas')
  expect(attrs).toContain('source="rclaude"')
  expect(attrs).toContain('sender="canvas"')
  expect(channelMeta(d, 'canvas')).toMatchObject({ source: 'rclaude', sender: 'canvas' })
})

test('the reply address is the canvas sink, so replying needs no lookup', () => {
  const d = delivery({ fromConversation: 'canvas:cnv_123', canvasId: 'cnv_123' })
  expect(channelAttrs(d, 'canvas')).toContain('from_conversation="canvas:cnv_123"')
  expect(channelMeta(d, 'canvas').from_conversation).toBe('canvas:cnv_123')
})

test('the selection is rendered ABOVE the message, where "these" resolves', () => {
  const body = deliveryBody(delivery({ message: 'make these blue', selection }))
  const lines = body.split('\n')

  expect(lines[0]).toContain('<selected id="a"')
  expect(lines[1]).toContain('<selected id="b"')
  expect(lines[2]).toBe('make these blue')
})

test('no selection leaves the body exactly as sent', () => {
  expect(deliveryBody(delivery({ canvasId: 'cnv_123', message: 'just chatting' }))).toBe('just chatting')
  expect(deliveryBody(delivery({ selection: { count: 0, elements: [], truncated: false } }))).toBe('hello')
})

test('optional fields appear only when present', () => {
  const bare = channelMeta(delivery(), 'conversation')
  expect(bare.source).toBeUndefined()
  expect(bare.conversation_id).toBeUndefined()
  expect(bare.context).toBeUndefined()

  const full = channelMeta(delivery({ source: 'rclaude', conversationId: 'conv_x', context: 'ctx' }), 'orb')
  expect(full).toMatchObject({ source: 'rclaude', conversation_id: 'conv_x', context: 'ctx', sender: 'orb' })
})

test('the orb envelope is unchanged by the canvas work', () => {
  // Regression guard: canvas and orb share this code path.
  const d = delivery({ fromConversation: 'orb:abc', fromProject: 'orb', sender: 'orb', source: 'rclaude' })
  const attrs = channelAttrs(d, 'orb')
  expect(attrs).toBe('source="rclaude" sender="orb" from_conversation="orb:abc" from_project="orb" intent="request"')
})

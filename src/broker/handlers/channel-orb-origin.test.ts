import { describe, expect, it } from 'bun:test'
import { stampOrbOrigin } from './channel'

/**
 * Regression: the voice orb is a sanctioned surface == the user's own voice.
 * When an orb->conversation message rides the GENERIC channel path (post the
 * "orb is a real channel" refactor, fb7359b8) the delivery envelope must still
 * carry sender="orb" + source="rclaude" -- otherwise the panel renders it as a
 * teal peer bubble ("from <shortid> REQUEST") instead of the violet "from Orb",
 * AND the receiving agent treats the user's spoken request as an UNTRUSTED PEER.
 * Both the live builder (deliverToOne) and the offline-queue builder
 * (buildQueuedDelivery) drop these markers today; this locks them back on.
 */
describe('stampOrbOrigin', () => {
  it('stamps sender=orb + source=rclaude for an orb:<id> origin', () => {
    const d: Record<string, unknown> = { type: 'channel_deliver', fromConversation: 'orb:6uwk3p', fromProject: 'orb' }
    stampOrbOrigin(d, 'orb', 'orb:6uwk3p')
    expect(d.sender).toBe('orb')
    expect(d.source).toBe('rclaude')
  })

  it('stamps for a bare "orb" origin (all-panels address)', () => {
    const d: Record<string, unknown> = { type: 'channel_deliver' }
    stampOrbOrigin(d, 'orb', 'orb')
    expect(d.sender).toBe('orb')
    expect(d.source).toBe('rclaude')
  })

  it('leaves a normal peer delivery untouched -- it must render as a peer, not the user', () => {
    const d: Record<string, unknown> = { type: 'channel_deliver', fromConversation: 'arr:viral-zebra', fromProject: 'arr' }
    stampOrbOrigin(d, 'arr', 'arr:viral-zebra')
    expect(d.sender).toBeUndefined()
    expect(d.source).toBeUndefined()
  })

  it('does not false-positive on an "orbital"-like project that merely starts with orb', () => {
    const d: Record<string, unknown> = { type: 'channel_deliver' }
    stampOrbOrigin(d, 'orbital', 'orbital:some-conv')
    expect(d.sender).toBeUndefined()
    expect(d.source).toBeUndefined()
  })
})

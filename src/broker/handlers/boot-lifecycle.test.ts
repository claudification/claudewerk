/**
 * launch_event handler -- replay behaviour.
 *
 * The agent host buffers every launch step and resends the WHOLE buffer on each
 * WS (re)connect (`replayLaunchEvents`, src/claude-agent-host/launch-events.ts).
 * A broker restart therefore re-delivers the full launch timeline for every live
 * conversation. That used to append a second, identical LAUNCH card into the
 * middle of the running transcript, because the re-ingest minted a fresh seq and
 * the dashboard's only dedup is `seq > lastApplied`.
 */

import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { launchEvent } from './boot-lifecycle'

interface Broadcast {
  channel: string
  message: { entries: TranscriptEntry[] }
}

/** Fake conversation store whose ingest mimics the real contract: entries whose
 *  uuid it has already seen are NOT returned, so they are not broadcast. */
function fakeCtx() {
  const seen = new Set<string>()
  const broadcasts: Broadcast[] = []
  const ingested: TranscriptEntry[] = []
  const ctx = {
    ws: { data: {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    conversations: {
      getConversation: (id: string) => (id === 'conv1' ? { id: 'conv1' } : undefined),
      findConversationByConversationId: () => undefined,
      addTranscriptEntries: (_id: string, entries: TranscriptEntry[]) => {
        const fresh = entries.filter(e => !seen.has(e.uuid as string))
        for (const e of fresh) seen.add(e.uuid as string)
        ingested.push(...fresh)
        return fresh
      },
      broadcastToChannel: (channel: string, _id: string, message: unknown) =>
        broadcasts.push({ channel, message: message as { entries: TranscriptEntry[] } }),
    },
  } as unknown as HandlerContext
  return { ctx, broadcasts, ingested }
}

const step = (name: string, t: number): MessageData =>
  ({
    conversationId: 'conv1',
    launchId: 'launch-1',
    phase: 'boot',
    step: name,
    t,
  }) as unknown as MessageData

describe('launch_event', () => {
  it('ingests and broadcasts a launch step the first time', () => {
    const { ctx, broadcasts, ingested } = fakeCtx()
    launchEvent(ctx, step('launch_started', 1000))
    expect(ingested).toHaveLength(1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].channel).toBe('conversation:transcript')
  })

  it('ignores a replayed step -- no second card', () => {
    const { ctx, broadcasts, ingested } = fakeCtx()
    launchEvent(ctx, step('launch_started', 1000))
    launchEvent(ctx, step('init_received', 1400))
    launchEvent(ctx, step('ready', 1800))
    expect(ingested).toHaveLength(3)
    expect(broadcasts).toHaveLength(3)

    // Broker restart: the host reconnects and replays the same three steps.
    launchEvent(ctx, step('launch_started', 1000))
    launchEvent(ctx, step('init_received', 1400))
    launchEvent(ctx, step('ready', 1800))

    expect(ingested).toHaveLength(3)
    expect(broadcasts).toHaveLength(3)
  })

  it('stamps the HOST clock, so a replayed timeline keeps real elapsed times', () => {
    const { ctx, ingested } = fakeCtx()
    launchEvent(ctx, step('launch_started', 1_000_000))
    launchEvent(ctx, step('ready', 1_002_500))

    const times = ingested.map(e => new Date(e.timestamp as string).getTime())
    // 2.5s apart, as the host measured it. Stamping receipt time instead
    // collapsed every step to the same instant -- the "+0.0s +0.0s +0.0s"
    // signature of a replayed card.
    expect(times[1] - times[0]).toBe(2500)
  })

  it('falls back to receipt time when the host sent no clock', () => {
    const { ctx, ingested } = fakeCtx()
    const before = Date.now()
    launchEvent(ctx, {
      conversationId: 'conv1',
      launchId: 'launch-1',
      phase: 'boot',
      step: 'ready',
    } as unknown as MessageData)
    const stamped = new Date(ingested[0].timestamp as string).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before)
  })

  it('drops an event for an unknown conversation', () => {
    const { ctx, broadcasts, ingested } = fakeCtx()
    launchEvent(ctx, { ...step('ready', 1000), conversationId: 'nope' } as unknown as MessageData)
    expect(ingested).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })
})

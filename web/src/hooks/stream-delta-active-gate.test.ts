import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from './use-conversations'
import { flushStreamDeltas, handlers } from './use-websocket-handlers'

/**
 * Cold-load duplicate-bubble guard: a `content_block_delta` for a conversation
 * that is NOT active is a stale tail (e.g. the live delta that lands just after
 * the isInitial HTTP snapshot already committed the assistant entry). Accepting
 * it repopulates `streamingText` with nothing left to clear it -> an orphaned
 * streaming bubble duplicated below the committed text. Only an ACTIVE turn may
 * grow the buffer. message_start / message_stop stay ungated (reset/clear).
 *
 * Delta writes are batched (W-H2): a content_block_delta only buffers; the
 * store is written when flushStreamDeltas() runs (rAF / 100ms timer, or the
 * synchronous force-flush on message_stop). Tests flush explicitly.
 */
describe('handleStreamDelta -- active-status gate', () => {
  const sid = 'conv_gate_test'

  function setStatus(status: string) {
    useConversationsStore.setState({
      conversationsById: { [sid]: { id: sid, status } } as never,
    })
  }

  function textDelta(text: string) {
    handlers.stream_delta({
      type: 'stream_delta',
      conversationId: sid,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    } as never)
  }

  function messageStop() {
    handlers.stream_delta({ type: 'stream_delta', conversationId: sid, event: { type: 'message_stop' } } as never)
  }

  beforeEach(() => {
    useConversationsStore.setState({ streamingText: {}, streamingThinking: {} })
  })
  afterEach(() => {
    // Drain + cancel any scheduled flush so a leftover timer can't bleed into
    // the next test.
    flushStreamDeltas()
    useConversationsStore.setState({ streamingText: {}, streamingThinking: {}, conversationsById: {} as never })
  })

  it('drops a text delta when the conversation is idle', () => {
    setStatus('idle')
    textDelta('orphan tail')
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBeUndefined()
  })

  it('drops a text delta when the conversation is ended', () => {
    setStatus('ended')
    textDelta('orphan tail')
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBeUndefined()
  })

  it('accumulates a text delta while the conversation is active', () => {
    setStatus('active')
    textDelta('hello ')
    textDelta('world')
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBe('hello world')
  })

  it('still clears the buffer on message_stop even when no longer active', () => {
    setStatus('active')
    textDelta('partial response')
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBe('partial response')
    // Turn ends: status flips, then message_stop arrives. The clear must run
    // regardless of status -- it is not behind the content-delta gate.
    setStatus('idle')
    messageStop()
    expect(useConversationsStore.getState().streamingText[sid]).toBeUndefined()
  })
})

/**
 * Batching behaviour (W-H2): deltas coalesce into a single store write, the
 * final text/thinking is never late (message_stop force-flushes), and stale
 * buffered deltas can never resurrect a cleared buffer.
 */
describe('handleStreamDelta -- delta batching', () => {
  const sid = 'conv_batch_test'

  function setStatus(status: string) {
    useConversationsStore.setState({ conversationsById: { [sid]: { id: sid, status } } as never })
  }
  function send(event: Record<string, unknown>) {
    handlers.stream_delta({ type: 'stream_delta', conversationId: sid, event } as never)
  }
  function textDelta(text: string) {
    send({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
  }
  function thinkingDelta(thinking: string) {
    send({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } })
  }

  beforeEach(() => {
    setStatus('active')
    useConversationsStore.setState({ streamingText: {}, streamingThinking: {} })
  })
  afterEach(() => {
    flushStreamDeltas()
    useConversationsStore.setState({ streamingText: {}, streamingThinking: {}, conversationsById: {} as never })
  })

  it('does not write the store until flushed, then commits the coalesced text', () => {
    textDelta('foo')
    textDelta('bar')
    // Buffered only -- nothing in the store yet.
    expect(useConversationsStore.getState().streamingText[sid]).toBeUndefined()
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBe('foobar')
  })

  it('message_stop force-flushes buffered thinking and clears text', () => {
    textDelta('answer text')
    thinkingDelta('private reasoning')
    // No explicit flush -- message_stop must land the buffered deltas itself.
    send({ type: 'message_stop' })
    const state = useConversationsStore.getState()
    expect(state.streamingText[sid]).toBeUndefined() // text cleared (committed entry replaces)
    expect(state.streamingThinking[sid]).toBe('private reasoning') // thinking retained
  })

  it('message_start drops buffered deltas so a late flush cannot resurrect them', () => {
    textDelta('stale from prior turn')
    send({ type: 'message_start' })
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBeFalsy()
  })

  it('a committed assistant entry drops buffered deltas (no orphan bubble)', () => {
    textDelta('mid-stream tail')
    handlers.transcript_entries({
      type: 'transcript_entries',
      conversationId: sid,
      entries: [{ type: 'assistant', seq: 1, message: { content: [{ type: 'text', text: 'committed' }] } }],
    } as never)
    flushStreamDeltas()
    expect(useConversationsStore.getState().streamingText[sid]).toBeFalsy()
  })
})

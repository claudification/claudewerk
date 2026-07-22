import { describe, expect, it } from 'vitest'
import { parseFunctionCalls, toVoiceAction } from './realtime-events'

describe('parseFunctionCalls', () => {
  it('extracts function_call items and parses their args, echoing call_id', () => {
    const calls = parseFunctionCalls({
      response: {
        output: [
          { type: 'message', id: 'm1' },
          { type: 'function_call', id: 'i1', call_id: 'c1', name: 'read_events', arguments: '{"conversationId":"a"}' },
        ],
      },
    })
    expect(calls).toEqual([{ callId: 'c1', name: 'read_events', args: { conversationId: 'a' } }])
  })

  it('falls back to the item id when call_id is absent, and tolerates bad JSON args', () => {
    const calls = parseFunctionCalls({
      response: { output: [{ type: 'function_call', id: 'i2', name: 'projects_overview', arguments: 'not json' }] },
    })
    expect(calls).toEqual([{ callId: 'i2', name: 'projects_overview', args: {} }])
  })

  it('returns [] when there is no output', () => {
    expect(parseFunctionCalls({})).toEqual([])
  })

  it('carries EVERY call in one response (the model can batch)', () => {
    const calls = parseFunctionCalls({
      response: {
        output: [
          { type: 'function_call', id: 'i1', call_id: 'c1', name: 'a', arguments: '{}' },
          { type: 'function_call', id: 'i2', call_id: 'c2', name: 'b', arguments: '{}' },
        ],
      },
    })
    expect(calls.map(c => c.callId)).toEqual(['c1', 'c2'])
  })
})

describe('toVoiceAction', () => {
  it('maps lifecycle + barge-in events', () => {
    expect(toVoiceAction({ type: 'response.created' })).toEqual({ kind: 'speaking' })
    expect(toVoiceAction({ type: 'input_audio_buffer.speech_started' })).toEqual({ kind: 'barge-in' })
    expect(toVoiceAction({ type: 'response.done', response: { output: [] } })).toEqual({ kind: 'done', calls: [] })
  })

  it('maps agent (partial + final) transcripts under BOTH preview and GA event names', () => {
    expect(toVoiceAction({ type: 'response.audio_transcript.delta', delta: 'he' })).toEqual({
      kind: 'transcript',
      role: 'agent',
      text: 'he',
      partial: true,
    })
    expect(toVoiceAction({ type: 'response.audio_transcript.done', transcript: 'hello' })).toEqual({
      kind: 'transcript',
      role: 'agent',
      text: 'hello',
      partial: false,
    })
    // GA gpt-realtime naming -- dropping these leaves the orb's own words missing.
    expect(toVoiceAction({ type: 'response.output_audio_transcript.delta', delta: 'ya' })).toEqual({
      kind: 'transcript',
      role: 'agent',
      text: 'ya',
      partial: true,
    })
    expect(toVoiceAction({ type: 'response.output_audio_transcript.done', transcript: 'right then' })).toEqual({
      kind: 'transcript',
      role: 'agent',
      text: 'right then',
      partial: false,
    })
  })

  it("maps the user's completed utterance", () => {
    expect(toVoiceAction({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hi' })).toEqual({
      kind: 'transcript',
      role: 'user',
      text: 'hi',
      partial: false,
    })
  })

  it('maps errors and ignores the unknown', () => {
    expect(toVoiceAction({ type: 'error', error: { message: 'boom' } })).toEqual({ kind: 'error', message: 'boom' })
    expect(toVoiceAction({ type: 'error' })).toEqual({ kind: 'error', message: 'realtime error' })
    expect(toVoiceAction({ type: 'something.else' })).toEqual({ kind: 'ignore' })
  })
})

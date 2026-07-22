/**
 * Pure parsing of the OpenAI Realtime data-channel event stream into normalized
 * actions the voice session applies. Kept separate from the WebRTC transport so
 * the event mapping (the part with real logic) is unit-testable without an
 * RTCPeerConnection. Event shapes verified against developers.openai.com.
 */

/** High-level session state for the orb (listening / thinking / speaking). */
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

/** One model-issued tool call. Echo `callId` (the function_call's call_id, NOT
 *  the item id) on the result, or the model never receives the output. */
export interface FunctionCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

/** Normalized action derived from one raw realtime event. */
export type VoiceAction =
  | { kind: 'speaking' } // response.created
  | { kind: 'done'; calls: FunctionCall[] } // response.done (may carry tool calls)
  | { kind: 'barge-in' } // the user started talking over the orb
  | { kind: 'transcript'; role: 'agent' | 'user'; text: string; partial: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }

/** Pull the function_call items out of a response.done event's output array. */
export function parseFunctionCalls(ev: { [k: string]: unknown }): FunctionCall[] {
  const out = (ev.response as { output?: unknown[] })?.output ?? []
  const calls: FunctionCall[] = []
  for (const item of out as Array<{
    type: string
    id: string
    call_id?: string
    name: string
    arguments?: string
  }>) {
    if (item.type !== 'function_call') continue
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
    } catch {
      // leave args empty -- the broker's zod gate surfaces its own validation error
    }
    calls.push({ callId: item.call_id ?? item.id, name: item.name, args })
  }
  return calls
}

/** Agent-speech transcript event names. The GA gpt-realtime models emit
 *  `response.output_audio_transcript.*`; older preview models emit
 *  `response.audio_transcript.*`. Handle BOTH -- without the GA name the orb's
 *  own words never land in the transcript. */
const AGENT_DELTA = new Set(['response.audio_transcript.delta', 'response.output_audio_transcript.delta'])
const AGENT_DONE = new Set(['response.audio_transcript.done', 'response.output_audio_transcript.done'])

/** Map one raw (already JSON-parsed) realtime event to a normalized action. */
export function toVoiceAction(ev: { type: string; [k: string]: unknown }): VoiceAction {
  if (AGENT_DELTA.has(ev.type)) {
    return { kind: 'transcript', role: 'agent', text: String(ev.delta ?? ''), partial: true }
  }
  if (AGENT_DONE.has(ev.type)) {
    return { kind: 'transcript', role: 'agent', text: String(ev.transcript ?? ''), partial: false }
  }
  switch (ev.type) {
    case 'response.created':
      return { kind: 'speaking' }
    case 'response.done':
      return { kind: 'done', calls: parseFunctionCalls(ev) }
    case 'input_audio_buffer.speech_started':
      return { kind: 'barge-in' }
    // The user's own speech -- the final completed utterance.
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'transcript', role: 'user', text: String(ev.transcript ?? ''), partial: false }
    case 'error':
      return {
        kind: 'error',
        message: String((ev as { error?: { message?: string } }).error?.message ?? 'realtime error'),
      }
    default:
      return { kind: 'ignore' }
  }
}

/**
 * The client events the session sends, as PURE builders.
 *
 * They live out of voice-session.ts because each one carries a hard-won detail
 * about the GA wire format, and a comment that long inside a state machine is
 * where the state machine goes to die. Pure, so the shapes are unit-tested
 * without a peer connection.
 */

export interface RealtimeClientEvent {
  type: string
  [k: string]: unknown
}

/**
 * A speaking-rate change on a LIVE session. TWO things this got wrong before,
 * both user-visible:
 *  1. `session` is a TAGGED union in the GA API -- without `type: 'realtime'`
 *     the server rejects the update with "Missing required parameter:
 *     'session.type'", which lands as a red error the moment the orb connects.
 *  2. the docs do not say whether an update MERGES or REPLACES, so sending
 *     `{audio:{output:{speed}}}` alone risks dropping the input transcription
 *     and the turn detection -- no transcripts, no barge-in. Echo the whole
 *     minted block back with only the speed changed.
 */
export function speedUpdate(mintedAudio: Record<string, unknown> | null, speed: number): RealtimeClientEvent {
  const output = { ...(mintedAudio?.output as Record<string, unknown>), speed }
  return { type: 'session.update', session: { type: 'realtime', audio: { ...mintedAudio, output } } }
}

// NO voiceUpdate: the OUTPUT voice is NOT changeable on a live session. OpenAI
// locks it the instant the model produces its first audio ("Cannot update a
// conversation's voice if assistant audio is present"), and the orb greets on
// connect -- so by the time anyone could change it, it is already locked. A
// voice change re-mints instead (a full session restart, voice baked in at
// mint). See use-orb-live-settings.ts (useOrbLiveSettings -> onReloadRequest).

/**
 * Something the orb says WITHOUT being asked (proactive narration), injected as
 * a conversation item so it answers IN PERSONA and remembers saying it -- a
 * `response.instructions` override would replace the persona for that turn,
 * which is how a snarky orb suddenly sounds like a form letter.
 */
export function announceItem(note: string): RealtimeClientEvent {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }] },
  }
}

/** The result of a tool the model called, handed back by call id. */
export function toolOutputItem(callId: string, output: unknown): RealtimeClientEvent {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  }
}

export const RESPONSE_CREATE: RealtimeClientEvent = { type: 'response.create' }
export const RESPONSE_CANCEL: RealtimeClientEvent = { type: 'response.cancel' }

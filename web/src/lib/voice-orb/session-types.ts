/**
 * The session's two collaborator interfaces -- what it needs (config) and what
 * it reports (handlers). Their own module so voice-session.ts is the state
 * machine and nothing else.
 */

import type { FunctionCall, VoiceState } from './realtime-events'
import type { MintedToken } from './webrtc-transport'

export interface VoiceSessionConfig {
  /** Mint the ephemeral token (POST /api/desk/voice/token). */
  mintToken(): Promise<MintedToken>
  /** Run a tool the model called -- the tool-bridge: client-local verbs are
   *  answered in the browser, everything else crosses the broker's gated
   *  `voice_tool_call` seam. */
  runTool(call: FunctionCall): Promise<unknown>
}

export interface VoiceHandlers {
  /** The orb started a new spoken response. */
  onResponseStart?(): void
  /** A response finished with NO pending tool calls -- the turn is sealed. */
  onResponseEnd?(): void
  /** The user started speaking -- the turn boundary (seals the open turn now,
   *  since the user's own transcript arrives late and async). */
  onUserSpeechStart?(): void
  /** Orb speech (partial = streaming delta) or the user's final transcript. */
  onTranscript?(role: 'agent' | 'user', text: string, partial: boolean): void
  onState?(state: VoiceState): void
  onOpen?(): void
  onError?(msg: string): void
}

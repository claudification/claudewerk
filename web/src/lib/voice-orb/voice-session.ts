/**
 * The voice orb's SESSION half: the event pump over a live RealtimeTransport.
 * Owns turn state (speaking / thinking / listening), barge-in cancellation, the
 * tool round-trip, and typed input. Knows nothing about SDP or media devices --
 * that is webrtc-transport.ts -- and nothing about event shapes, which are
 * normalized by realtime-events.ts.
 */

import { type FunctionCall, toVoiceAction, type VoiceAction, type VoiceState } from './realtime-events'
import { connectRealtime, type MintedToken, type RealtimeTransport } from './webrtc-transport'

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

export class VoiceSession {
  private transport?: RealtimeTransport
  private responseActive = false
  private closed = false

  constructor(
    private readonly cfg: VoiceSessionConfig,
    private readonly handlers: VoiceHandlers,
  ) {}

  async start(): Promise<void> {
    this.handlers.onState?.('connecting')
    let token: MintedToken
    try {
      token = await this.cfg.mintToken()
    } catch (e) {
      this.fail(`could not start the voice session: ${(e as Error).message}`)
      throw e
    }
    try {
      this.transport = await connectRealtime(token, {
        onOpen: () => this.onChannelOpen(),
        onMessage: raw => this.onMessage(raw),
        onClose: reason => this.onTransportClose(reason),
      })
    } catch (e) {
      this.fail((e as Error).message)
      throw e
    }
    if (this.closed) this.transport.close()
  }

  // The session is already configured at mint -- just announce and kick the
  // opening turn so the orb greets first instead of waiting for the user.
  private onChannelOpen(): void {
    this.handlers.onOpen?.()
    this.handlers.onState?.('listening')
    this.transport?.send({ type: 'response.create' })
  }

  private onTransportClose(reason: string): void {
    if (this.closed) return
    this.handlers.onError?.(reason)
    this.close()
  }

  private onMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const action = toVoiceAction(parsed as { type: string; [k: string]: unknown })
    this.apply(action)
  }

  /** One handler per normalized action kind (strategy map, not a switch). */
  private apply(action: VoiceAction): void {
    const apply: Record<VoiceAction['kind'], () => void> = {
      speaking: () => {
        this.responseActive = true
        this.handlers.onState?.('speaking')
        this.handlers.onResponseStart?.()
      },
      done: () => this.onResponseDone(action as Extract<VoiceAction, { kind: 'done' }>),
      'barge-in': () => this.onBargeIn(),
      transcript: () => {
        const t = action as Extract<VoiceAction, { kind: 'transcript' }>
        this.handlers.onTranscript?.(t.role, t.text, t.partial)
      },
      error: () => this.handlers.onError?.((action as Extract<VoiceAction, { kind: 'error' }>).message),
      ignore: () => {},
    }
    apply[action.kind]()
  }

  private onResponseDone(action: Extract<VoiceAction, { kind: 'done' }>): void {
    this.responseActive = false
    this.handlers.onState?.('listening')
    if (action.calls.length === 0) this.handlers.onResponseEnd?.()
    for (const call of action.calls) void this.dispatchTool(call)
  }

  /** The user talked over the orb: seal the open turn NOW (the user transcript
   *  that proves a new turn arrives late + async, so we cannot wait for it) and
   *  cancel the in-flight response so it stops mid-sentence. */
  private onBargeIn(): void {
    this.handlers.onState?.('listening')
    this.handlers.onUserSpeechStart?.()
    if (!this.responseActive) return
    this.transport?.send({ type: 'response.cancel' })
    this.responseActive = false
  }

  private async dispatchTool(call: FunctionCall): Promise<void> {
    this.handlers.onState?.('thinking')
    let output: unknown
    try {
      output = await this.cfg.runTool(call)
    } catch (e) {
      output = { error: String(e) }
    }
    if (this.closed) return
    this.transport?.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) },
    })
    this.transport?.send({ type: 'response.create' })
  }

  /** Make the orb say something it was not asked for (proactive narration).
   *  Injected as a conversation item so the orb answers IN PERSONA and
   *  remembers it said it -- a `response.instructions` override would replace
   *  the persona for that turn, which is how a snarky orb suddenly sounds like
   *  a form letter. */
  announce(note: string): void {
    this.transport?.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }] },
    })
    this.transport?.send({ type: 'response.create' })
  }

  /** Live mic + remote streams, for the orb's audio reactivity. */
  audioStreams(): MediaStream[] {
    return this.transport?.audioStreams() ?? []
  }

  setMicEnabled(enabled: boolean): Promise<void> {
    return this.transport?.setMicEnabled(enabled) ?? Promise.resolve()
  }

  private fail(msg: string): void {
    this.handlers.onError?.(msg)
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport?.close()
    // Drop the reference too: a late announce / mute after teardown must be a
    // no-op, not a send into a dead peer connection.
    this.transport = undefined
    this.handlers.onState?.('idle')
  }
}

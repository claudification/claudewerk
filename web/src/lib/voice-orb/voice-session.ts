/**
 * The voice orb's SESSION half: the event pump over a live RealtimeTransport.
 * Owns turn state (speaking / thinking / listening), barge-in cancellation, the
 * tool round-trip, and typed input. Knows nothing about SDP or media devices --
 * that is webrtc-transport.ts -- and nothing about event shapes, which are
 * normalized by realtime-events.ts.
 */

import { type FunctionCall, toVoiceAction, type VoiceAction } from './realtime-events'
import { announceItem, RESPONSE_CANCEL, RESPONSE_CREATE, speedUpdate, toolOutputItem } from './session-messages'
import type { VoiceHandlers, VoiceSessionConfig } from './session-types'
import { createSpeedLatch, type SpeedLatch } from './speed-latch'
import { connectRealtime, type MintedToken, type RealtimeTransport } from './webrtc-transport'

export type { VoiceHandlers, VoiceSessionConfig } from './session-types'

export class VoiceSession {
  private transport?: RealtimeTransport
  private responseActive = false
  /** We ASKED for a response but the first audio event has not landed yet. A
   *  turn starts at `response.create`, not at the first sound -- without this
   *  the gap between them looks idle and a rate change sent into it is dropped
   *  by the API with nothing left to retry. */
  private responsePending = false
  private closed = false
  /** The audio config the session was minted with (see MintedToken.audio). */
  private mintedAudio: Record<string, unknown> | null = null
  /** Holds the wanted speaking rate until a turn boundary (see speed-latch.ts). */
  private readonly speed: SpeedLatch

  constructor(
    private readonly cfg: VoiceSessionConfig,
    private readonly handlers: VoiceHandlers,
  ) {
    this.speed = createSpeedLatch({
      // No transport yet, or mid-response: both are windows where the API
      // ignores a rate change, so the latch holds it instead of burning it.
      isBusy: () => this.responseActive || this.responsePending || !this.transport,
      apply: rate => this.pushSpeed(rate),
    })
  }

  async start(): Promise<void> {
    this.handlers.onState?.('connecting')
    let token: MintedToken
    try {
      token = await this.cfg.mintToken()
      const audio = token.audio
      if (audio && typeof audio === 'object') {
        this.mintedAudio = audio as Record<string, unknown>
        const minted = (this.mintedAudio.output as { speed?: unknown } | undefined)?.speed
        if (typeof minted === 'number') this.speed.minted(minted)
      }
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
    this.requestResponse()
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
      error: () => {
        const e = action as Extract<VoiceAction, { kind: 'error' }>
        // A race is not a failure -- log it, never put it in front of the user.
        if (e.benign) console.debug('[voice-orb] benign realtime error:', e.message)
        else this.handlers.onError?.(e.message)
      },
      ignore: () => {},
    }
    apply[action.kind]()
  }

  /** Ask for a turn. The pending flag makes the latch treat the whole request
   *  as busy, not just the part where sound is coming out. */
  private requestResponse(): void {
    this.responsePending = true
    this.transport?.send(RESPONSE_CREATE)
  }

  private onResponseDone(action: Extract<VoiceAction, { kind: 'done' }>): void {
    this.responseActive = false
    this.responsePending = false
    this.handlers.onState?.('listening')
    // A turn boundary is the ONLY moment the API accepts a new speaking rate.
    if (action.calls.length === 0) {
      this.speed.turnEnded()
      this.handlers.onResponseEnd?.()
    }
    for (const call of action.calls) void this.dispatchTool(call)
  }

  /** The user talked over the orb: seal the open turn NOW (the user transcript
   *  that proves a new turn arrives late + async, so we cannot wait for it) and
   *  cancel the in-flight response so it stops mid-sentence. */
  private onBargeIn(): void {
    this.handlers.onState?.('listening')
    this.handlers.onUserSpeechStart?.()
    if (!this.responseActive) return
    this.transport?.send(RESPONSE_CANCEL)
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
    this.transport?.send(toolOutputItem(call.callId, output))
    this.requestResponse()
  }

  /** Make the orb say something it was not asked for (proactive narration). */
  announce(note: string): void {
    this.transport?.send(announceItem(note))
    this.requestResponse()
  }

  /** Change the speaking rate on the LIVE session. The API only accepts this
   *  BETWEEN turns, so the latch holds it until one and re-sends there -- a
   *  slider moved mid-sentence used to be swallowed for the rest of the
   *  session. No reconnect, no re-mint. */
  setSpeed(speed: number): void {
    this.speed.want(speed)
  }

  /** What the live session is speaking at, as far as we know (null before mint). */
  currentSpeed(): number | null {
    return this.speed.applied()
  }

  private pushSpeed(speed: number): void {
    console.debug('[voice-orb] speaking rate ->', speed)
    this.transport?.send(speedUpdate(this.mintedAudio, speed))
  }

  // NO setVoice: OpenAI locks the output voice once the orb has spoken (it
  // greets on connect, so that is immediately). A voice change re-mints the
  // whole session with the new voice instead -- see use-voice-orb.ts.

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

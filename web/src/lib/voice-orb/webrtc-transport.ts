/**
 * Browser <-> OpenAI Realtime over WebRTC -- the TRANSPORT half of the voice
 * orb (the session logic lives in voice-session.ts).
 *
 * The OpenAI key never reaches here: the broker mints a short-lived ephemeral
 * secret at POST /api/desk/voice/token (which bakes the persona + the voice
 * contract INTO the session at mint -- a client `session.update` after connect
 * does not apply consistently), and we negotiate WebRTC directly with OpenAI.
 * Audio flows browser <-> OpenAI; only TOOL CALLS come back through the broker.
 *
 * This file owns: peer connection, the DOM-attached <audio> sink, the mic
 * track, the data channel, and the SDP handshake. It knows nothing about
 * realtime event semantics.
 */

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

export interface MintedToken {
  value: string
  model: string
}

export interface TransportHandlers {
  onOpen(): void
  onMessage(raw: string): void
  onClose(reason: string): void
}

/** The live WebRTC leg. Created by `connectRealtime`, torn down by `close`. */
export class RealtimeTransport {
  private readonly pc: RTCPeerConnection
  private readonly dc: RTCDataChannel
  private audioEl: HTMLAudioElement | undefined
  // Explicit `| undefined` (not `?`) so mute/close can RE-assign undefined to
  // release the track under exactOptionalPropertyTypes.
  private micTrack: MediaStreamTrack | undefined
  private micSender: RTCRtpSender | undefined
  private closed = false
  // STABLE wrapper around the current mic track. Rebuilding this per call --
  // which `audioStreams()` used to do -- hands the analyser a brand new object
  // every animation frame, and it dutifully builds a fresh AudioNode for each
  // one. Sixty native nodes a second is how you get a Safari tab OOM-killed.
  private micStream: MediaStream | undefined

  constructor(parts: {
    pc: RTCPeerConnection
    dc: RTCDataChannel
    audioEl: HTMLAudioElement
    micTrack: MediaStreamTrack | undefined
    micSender: RTCRtpSender | undefined
  }) {
    this.pc = parts.pc
    this.dc = parts.dc
    this.audioEl = parts.audioEl
    this.micTrack = parts.micTrack
    this.micSender = parts.micSender
  }

  /** Send one realtime event. Silently dropped if the channel is not open --
   *  a queued event after teardown is worse than a lost one. */
  send(msg: unknown): void {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(msg))
  }

  /** Live audio streams for an external analyser (the orb's audio reactivity):
   *  the user's mic + the orb's remote audio. Empty until the WebRTC tracks
   *  land, so a caller polls it across frames. Analysis-only -- the remote
   *  stream already plays through `audioEl`. */
  audioStreams(): MediaStream[] {
    const out: MediaStream[] = []
    const mic = this.micStreamFor(this.micTrack)
    if (mic) out.push(mic)
    const remote = this.audioEl?.srcObject
    if (remote instanceof MediaStream) out.push(remote)
    return out
  }

  /** The wrapper for `track`, built once and reused until the track changes. */
  private micStreamFor(track: MediaStreamTrack | undefined): MediaStream | undefined {
    if (!track) {
      this.micStream = undefined
      return undefined
    }
    const current = this.micStream?.getAudioTracks()[0]
    if (!this.micStream || current !== track) this.micStream = new MediaStream([track])
    return this.micStream
  }

  /** Mute / unmute WITHOUT tearing down the session. Muting RELEASES the
   *  capture device (track.stop) so the OS "mic in use" indicator goes off --
   *  merely toggling `track.enabled` keeps the device hot, which is not real
   *  mute. Unmuting re-acquires a fresh track and swaps it into the live sender
   *  (replaceTrack -- no renegotiation), so the connection and the model's
   *  conversation context stay alive. */
  async setMicEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.micTrack?.stop()
      this.micTrack = undefined
      await this.micSender?.replaceTrack(null)
      return
    }
    if (this.micTrack || this.closed) return
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    const track = mic.getTracks()[0]
    if (!track || this.closed) {
      track?.stop()
      return
    }
    this.micTrack = track
    await this.micSender?.replaceTrack(track)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // Stop the mic FIRST so the OS capture indicator goes off the instant the
    // user closes the orb -- closing the peer connection alone leaves the
    // device track live.
    this.micTrack?.stop()
    this.micTrack = undefined
    this.micStream = undefined
    this.dc.close()
    this.pc.close()
    this.audioEl?.remove()
    this.audioEl = undefined
  }
}

/** Remote audio MUST be a DOM-attached <audio> or Safari silently refuses to
 *  play a WebRTC stream from a detached element. */
function attachAudioSink(pc: RTCPeerConnection): HTMLAudioElement {
  const audio = document.createElement('audio')
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  audio.style.display = 'none'
  document.body.appendChild(audio)
  pc.ontrack = e => {
    const [stream] = e.streams
    if (!stream) return
    audio.srcObject = stream
    void audio.play().catch(err => console.debug('[voice-orb] autoplay blocked:', String(err)))
  }
  return audio
}

async function negotiate(pc: RTCPeerConnection, token: MintedToken): Promise<void> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  const res = await fetch(`${CALLS_URL}?model=${encodeURIComponent(token.model)}`, {
    method: 'POST',
    body: offer.sdp ?? '',
    headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`realtime handshake ${res.status}: ${body.slice(0, 160)}`)
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
}

/** Open the mic, negotiate with OpenAI, and hand back the live transport. */
export async function connectRealtime(token: MintedToken, handlers: TransportHandlers): Promise<RealtimeTransport> {
  const pc = new RTCPeerConnection()
  const audioEl = attachAudioSink(pc)

  let micTrack: MediaStreamTrack | undefined
  let micSender: RTCRtpSender | undefined
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
    micTrack = mic.getTracks()[0]
    if (micTrack) micSender = pc.addTrack(micTrack)
  } catch (e) {
    audioEl.remove()
    pc.close()
    throw new Error(`microphone permission denied: ${String(e)}`)
  }

  const dc = pc.createDataChannel('oai-events')
  dc.addEventListener('open', () => handlers.onOpen())
  dc.addEventListener('message', e => handlers.onMessage(String(e.data)))
  dc.addEventListener('close', () => handlers.onClose('data channel closed'))
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') handlers.onClose('peer connection failed')
  })

  try {
    await negotiate(pc, token)
  } catch (e) {
    micTrack?.stop()
    audioEl.remove()
    pc.close()
    throw e
  }
  return new RealtimeTransport({ pc, dc, audioEl, micTrack, micSender })
}

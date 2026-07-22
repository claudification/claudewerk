/**
 * The mic-release path, tested on a stubbed peer connection. This is the piece
 * that decides whether the OS "microphone in use" indicator goes off -- toggling
 * `track.enabled` would look muted and keep the device hot, which is the bug
 * this class exists to avoid.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeTransport } from './webrtc-transport'

function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack
}

/** `track: null` = the transport has no mic yet (pre-track / released). */
function build(track: MediaStreamTrack | null = fakeTrack()) {
  const replaceTrack = vi.fn(async () => {})
  const dc = { readyState: 'open', send: vi.fn(), close: vi.fn() } as unknown as RTCDataChannel
  const pc = { close: vi.fn() } as unknown as RTCPeerConnection
  const audioEl = { srcObject: null, remove: vi.fn() } as unknown as HTMLAudioElement
  const micSender = { replaceTrack } as unknown as RTCRtpSender
  const transport = new RealtimeTransport({ pc, dc, audioEl, micTrack: track ?? undefined, micSender })
  return { transport, track, replaceTrack, dc, pc, audioEl }
}

const getUserMedia = vi.fn()

// jsdom ships neither MediaStream nor mediaDevices.
class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[] = []) {}
}

beforeEach(() => {
  getUserMedia.mockReset()
  vi.stubGlobal('MediaStream', FakeMediaStream)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
})

describe('send', () => {
  it('sends JSON while the channel is open, and drops it once closed', () => {
    const { transport, dc } = build()
    transport.send({ type: 'response.create' })
    expect(dc.send).toHaveBeenCalledWith('{"type":"response.create"}')
    ;(dc as { readyState: string }).readyState = 'closed'
    transport.send({ type: 'response.cancel' })
    expect(dc.send).toHaveBeenCalledTimes(1)
  })
})

describe('setMicEnabled', () => {
  it('MUTING stops the device track and detaches it from the sender', async () => {
    const { transport, track, replaceTrack } = build()
    await transport.setMicEnabled(false)
    expect(track.stop).toHaveBeenCalled()
    expect(replaceTrack).toHaveBeenCalledWith(null)
  })

  it('UNMUTING re-acquires and swaps in without renegotiating', async () => {
    const { transport, replaceTrack } = build()
    await transport.setMicEnabled(false)
    const fresh = fakeTrack()
    getUserMedia.mockResolvedValue({ getTracks: () => [fresh] })
    await transport.setMicEnabled(true)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(replaceTrack).toHaveBeenLastCalledWith(fresh)
  })

  it('unmuting while already live is a no-op (no second device open)', async () => {
    const { transport } = build()
    await transport.setMicEnabled(true)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('stops a track that lands AFTER the orb was closed mid-unmute', async () => {
    const { transport, replaceTrack } = build()
    await transport.setMicEnabled(false)
    const late = fakeTrack()
    let release: (v: unknown) => void = () => {}
    getUserMedia.mockReturnValue(new Promise(r => (release = r)))
    const unmuting = transport.setMicEnabled(true)
    // The user closes the orb while the device is still opening.
    transport.close()
    release({ getTracks: () => [late] })
    await unmuting
    expect(late.stop).toHaveBeenCalled()
    expect(replaceTrack).not.toHaveBeenCalledWith(late)
  })

  it('will not open the device at all once closed', async () => {
    const { transport } = build()
    transport.close()
    await transport.setMicEnabled(true)
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

describe('close', () => {
  it('releases the mic FIRST, then the channel, peer and audio sink -- once', () => {
    const { transport, track, dc, pc, audioEl } = build()
    transport.close()
    transport.close()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(dc.close).toHaveBeenCalledTimes(1)
    expect(pc.close).toHaveBeenCalledTimes(1)
    expect(audioEl.remove).toHaveBeenCalledTimes(1)
  })
})

describe('audioStreams', () => {
  it('offers the mic and the remote stream for analysis', () => {
    const { transport, audioEl } = build()
    expect(transport.audioStreams()).toHaveLength(1)
    ;(audioEl as { srcObject: unknown }).srcObject = new MediaStream()
    expect(transport.audioStreams()).toHaveLength(2)
  })

  it('is empty before any track lands', () => {
    const { transport } = build(null)
    expect(transport.audioStreams()).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { AudioLevelMeter } from './audio-level'

/** A fake Web Audio graph: `connect(analyser)` is what binds a stream's
 *  amplitude to its analyser, mirroring the real wiring order. */
interface FakeAnalyser {
  fftSize: number
  amp: number
  getFloatTimeDomainData(buf: Float32Array): void
}

function fakeContext(amplitudeByStream: Map<object, number>) {
  return {
    createAnalyser: (): FakeAnalyser => {
      const a: FakeAnalyser = { fftSize: 0, amp: 0, getFloatTimeDomainData: buf => buf.fill(a.amp) }
      return a
    },
    createMediaStreamSource: (source: object) => ({
      connect: (a: FakeAnalyser) => {
        a.amp = amplitudeByStream.get(source) ?? 0
      },
    }),
    close: async () => {},
  } as unknown as AudioContext
}

const stream = (tracks = 1) => ({ getAudioTracks: () => Array(tracks).fill({}) }) as unknown as MediaStream

describe('AudioLevelMeter', () => {
  it('is silent with nothing attached', () => {
    expect(new AudioLevelMeter(() => fakeContext(new Map())).level()).toBe(0)
  })

  it('reports the LOUDEST stream, clamped to 1', () => {
    const quiet = stream()
    const loud = stream()
    const amps = new Map<object, number>([
      [quiet, 0.01],
      [loud, 0.05],
    ])
    const meter = new AudioLevelMeter(() => fakeContext(amps))
    meter.attach([quiet, loud])
    const level = meter.level()
    expect(level).toBeGreaterThan(0.05 * 6 - 0.001)
    expect(level).toBeLessThanOrEqual(1)

    const blaring = stream()
    amps.set(blaring, 1)
    meter.attach([blaring])
    expect(meter.level()).toBe(1)
  })

  it('attaches each stream once, however often it is offered', () => {
    const connect = vi.fn()
    const ctx = {
      createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) }),
      createMediaStreamSource: () => ({ connect }),
      close: async () => {},
    } as unknown as AudioContext
    const meter = new AudioLevelMeter(() => ctx)
    const s = stream()
    meter.attach([s])
    meter.attach([s])
    meter.attach([s])
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('ignores a stream with no audio track (the orb before the tracks land)', () => {
    const connect = vi.fn()
    const ctx = {
      createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: () => {} }),
      createMediaStreamSource: () => ({ connect }),
      close: async () => {},
    } as unknown as AudioContext
    const meter = new AudioLevelMeter(() => ctx)
    meter.attach([stream(0)])
    expect(connect).not.toHaveBeenCalled()
    expect(meter.level()).toBe(0)
  })

  it('degrades to silence when Web Audio is unavailable, instead of throwing', () => {
    const meter = new AudioLevelMeter(() => {
      throw new Error('AudioContext blocked before a gesture')
    })
    expect(() => meter.attach([stream()])).not.toThrow()
    expect(meter.level()).toBe(0)
    expect(() => meter.close()).not.toThrow()
  })
})

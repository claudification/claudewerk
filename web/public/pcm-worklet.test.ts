/**
 * DSP tests for pcm-worklet.js.
 *
 * The worklet is a served file, not a module: it references AudioWorklet globals
 * (`sampleRate`, `AudioWorkletProcessor`, `registerProcessor`) that bun does not
 * have, and it cannot be imported. So we eval it with those globals stubbed and
 * drive the real classes -- no duplicated DSP, the shipped code is what runs.
 *
 * Runner: this file lives under `web/`, so it runs under VITEST. Importing
 * `bun:test` here makes vitest fail the whole file at load time while
 * `bun test` (scoped to `src/` by bunfig.toml) never picks it up -- i.e. the
 * tests silently stop running. Keep the imports vitest-native.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// Vite rewrites `import.meta.url` to a non-file URL, so resolve from the vitest
// root (`web/`) instead.
const SOURCE = readFileSync(join(process.cwd(), 'public/pcm-worklet.js'), 'utf8')

interface WorkletExports {
  PcmCaptureProcessor: new () => {
    port: { postMessage: (msg: unknown, transfer?: unknown[]) => void; onmessage: ((e: unknown) => void) | null }
    process: (inputs: Float32Array[][]) => boolean
  }
  AntiAliasFilter: new (fs: number, target: number, cutoff: number) => { process: (buf: Float32Array) => void }
  LOWPASS_HZ: number
  TARGET_RATE: number
}

/** Eval the worklet source with AudioWorklet globals stubbed at `fs` Hz. */
function loadWorklet(fs: number): WorkletExports {
  class StubProcessor {
    port = { postMessage: () => {}, onmessage: null }
  }
  const load = new Function(
    'sampleRate',
    'AudioWorkletProcessor',
    'registerProcessor',
    `${SOURCE}\nreturn globalThis.PcmCapture`,
  )
  return load(fs, StubProcessor, () => {}) as WorkletExports
}

function sine(freq: number, fs: number, samples: number): Float32Array {
  const buf = new Float32Array(samples)
  for (let i = 0; i < samples; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / fs)
  return buf
}

function rms(buf: Float32Array | Int16Array, scale = 1): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += (buf[i] / scale) * (buf[i] / scale)
  return Math.sqrt(sum / buf.length)
}

/** Run a full-length tone through the processor and collect the 16k Int16 output. */
function capture(fs: number, freq: number, seconds: number): Int16Array {
  const wk = loadWorklet(fs)
  const proc = new wk.PcmCaptureProcessor()
  const out: number[] = []
  proc.port.postMessage = (msg: unknown) => {
    const m = msg as { type: string; buffer?: ArrayBuffer }
    if (m.type === 'audio' && m.buffer) out.push(...new Int16Array(m.buffer))
  }
  const total = Math.floor(fs * seconds)
  const tone = sine(freq, fs, total)
  for (let i = 0; i + 128 <= total; i += 128) {
    proc.process([[tone.subarray(i, i + 128)]])
  }
  return Int16Array.from(out)
}

/** Ignore the filter's settling transient at the head of the stream. */
function steadyState(pcm: Int16Array): Int16Array {
  return pcm.subarray(Math.min(1600, pcm.length >> 1))
}

test('REGRESSION: a 12 kHz tone no longer aliases into the speech band', () => {
  // 48k -> 16k throws away 2 of 3 samples; 12 kHz folds onto 4 kHz, dead centre
  // of the vowel range. MEASURED against the pre-filter code: it came through at
  // 0.7071 -- the FULL amplitude of the tone, zero attenuation. Now ~0.003.
  const aliased = rms(steadyState(capture(48000, 12000, 0.5)), 32768)
  expect(aliased).toBeLessThan(0.05) // < -26 dBFS from a full-scale tone
})

test('REGRESSION: a 15 kHz tone no longer folds onto 1 kHz', () => {
  // Measured pre-filter: 0.7071. This is the one that turns keyboard clatter and
  // hiss into phantom vowels.
  const aliased = rms(steadyState(capture(48000, 15000, 0.5)), 32768)
  expect(aliased).toBeLessThan(0.01)
})

test('content just above Nyquist -- the hardest case -- is still knocked down', () => {
  // 9 kHz folds to 7 kHz and sits closest to the filter corner, so it gets the
  // least rejection of anything in the fold region (~-19 dB measured). Guards
  // against someone widening LOWPASS_HZ until this stops working.
  const aliased = rms(steadyState(capture(48000, 9000, 0.5)), 32768)
  expect(aliased).toBeLessThan(0.15)
})

test('speech-band content passes through essentially untouched', () => {
  // 1 kHz: a full-scale sine must survive the filter with its level intact.
  const passed = rms(steadyState(capture(48000, 1000, 0.5)), 32768)
  expect(passed).toBeGreaterThan(0.6) // sine RMS is 0.707; allow filter/quantization loss
  expect(passed).toBeLessThan(0.75)
})

test('the top of the speech band (3.4 kHz telephony edge) still passes', () => {
  const passed = rms(steadyState(capture(48000, 3400, 0.5)), 32768)
  expect(passed).toBeGreaterThan(0.6)
})

test('the filter is a no-op when the device already runs at the target rate', () => {
  const wk = loadWorklet(16000)
  const filter = new wk.AntiAliasFilter(16000, wk.TARGET_RATE, wk.LOWPASS_HZ)
  const tone = sine(1000, 16000, 512)
  const before = rms(tone)
  filter.process(tone)
  expect(rms(tone)).toBeCloseTo(before, 6)
})

test('44.1 kHz devices get a filter too (ratio is not an integer)', () => {
  const aliased = rms(steadyState(capture(44100, 12000, 0.5)), 32768)
  expect(aliased).toBeLessThan(0.05)
})

test('the cascade rolls off monotonically across the fold region', () => {
  const wk = loadWorklet(48000)
  let prev = Number.POSITIVE_INFINITY
  for (const freq of [1000, 4000, 7200, 10000, 14000, 20000]) {
    const filter = new wk.AntiAliasFilter(48000, wk.TARGET_RATE, wk.LOWPASS_HZ)
    const tone = sine(freq, 48000, 48000)
    filter.process(tone)
    const level = rms(tone.subarray(4800))
    expect(level).toBeLessThan(prev)
    prev = level
  }
  // By 20 kHz there is essentially nothing left to fold.
  expect(prev).toBeLessThan(0.001)
})

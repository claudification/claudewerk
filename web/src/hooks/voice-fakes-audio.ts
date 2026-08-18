// fallow-ignore-file unused-class-member -- test DOUBLES. Their members exist
// because the CODE UNDER TEST calls them (ctx.createGain, node.port.postMessage),
// not because the test files do, so static reachability cannot see the consumers.
/**
 * voice-fakes-audio - Web Audio doubles for the raw-PCM capture engine.
 *
 * jsdom has no AudioContext and no AudioWorklet, and the PCM path's whole risk is
 * ORDERING around the worklet port: the flush ack must land AFTER the final audio
 * message (or the tail of every utterance is lost) and audio produced after the
 * ack must not reach the socket (or speech from after the key release gets
 * transcribed). Both are modelled here with the real async shape rather than
 * stubbed away.
 *
 * Test-only, imported by *.test.ts via voice-fakes.
 */

type PortMessage = { type: string; buffer?: ArrayBuffer }

export class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []
  /** Set false to model a worklet that never answers a flush (the backstop path). */
  acksFlush = true
  /** Posted on flush before the ack, mimicking the sub-frame remainder. */
  tailChunk: ArrayBuffer | null = null

  readonly port: {
    onmessage: ((ev: { data: PortMessage }) => void) | null
    postMessage: (msg: PortMessage) => void
  }

  constructor(
    readonly context: unknown,
    readonly processorName: string,
  ) {
    FakeAudioWorkletNode.instances.push(this)
    this.port = { onmessage: null, postMessage: msg => this.receive(msg) }
  }

  static latest(): FakeAudioWorkletNode {
    const node = FakeAudioWorkletNode.instances.at(-1)
    if (!node) throw new Error('no AudioWorkletNode was constructed')
    return node
  }

  static reset() {
    FakeAudioWorkletNode.instances = []
  }

  /** Deliver one ~50ms PCM frame, as the live worklet would. */
  emit(buffer: ArrayBuffer) {
    this.port.onmessage?.({ data: { type: 'audio', buffer } })
  }

  /** The real contract: the drain posts its remainder FIRST, then acks -- on a
   *  later task, exactly like the message port. */
  private receive(msg: PortMessage) {
    if (msg?.type !== 'flush' || !this.acksFlush) return
    queueMicrotask(() => {
      if (this.tailChunk) this.emit(this.tailChunk)
      this.port.onmessage?.({ data: { type: 'flushed' } })
    })
  }

  connect() {}
  disconnect() {}
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  /** Modules the engine asked for, so a test can assert the cache-busted URL. */
  static modules: string[] = []
  /** Model a worklet module that fails to load (stale SW cache, offline). */
  static addModuleFails = false

  state: 'suspended' | 'running' | 'closed' = 'running'
  closed = false
  readonly destination = {}
  readonly audioWorklet = {
    addModule: async (url: string) => {
      FakeAudioContext.modules.push(url)
      if (FakeAudioContext.addModuleFails) throw new Error('addModule failed')
    },
  }

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  static latest(): FakeAudioContext {
    const ctx = FakeAudioContext.instances.at(-1)
    if (!ctx) throw new Error('no AudioContext was constructed')
    return ctx
  }

  static reset() {
    FakeAudioContext.instances = []
    FakeAudioContext.modules = []
    FakeAudioContext.addModuleFails = false
  }

  createMediaStreamSource(_stream: MediaStream) {
    return { connect() {}, disconnect() {} }
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} }
  }

  async resume() {
    this.state = 'running'
  }

  async suspend() {
    this.state = 'suspended'
  }

  async close() {
    this.closed = true
    // Terminal in the real API, and the code under test branches on it to decide
    // whether the shared context can be reused. Modelled, not stubbed.
    this.state = 'closed'
  }
}

/** Install the Web Audio doubles as globals. Returns a restore function. */
export function installAudioFakes(): () => void {
  const globals = globalThis as Record<string, unknown>
  const prevContext = globals.AudioContext
  const prevNode = globals.AudioWorkletNode
  FakeAudioContext.reset()
  FakeAudioWorkletNode.reset()
  globals.AudioContext = FakeAudioContext
  globals.AudioWorkletNode = FakeAudioWorkletNode
  return () => {
    globals.AudioContext = prevContext
    globals.AudioWorkletNode = prevNode
  }
}

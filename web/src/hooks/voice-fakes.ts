// fallow-ignore-file unused-class-member -- these are test DOUBLES. Their
// members exist because the code under test calls them (recorder.start,
// ws.send, MediaRecorder.isTypeSupported), not because the test files do, so
// static reachability cannot see the consumers.
/**
 * voice-fakes - MediaRecorder + WebSocket doubles for the direct-to-Deepgram
 * tests. jsdom ships neither, and both are the exact surfaces whose ORDERING
 * carried the bugs (recorder started too late, socket flushed too early), so
 * they are faked with the real async shape rather than stubbed away.
 *
 * Test-only, imported by *.test.ts.
 */

type DataHandler = (ev: { data: Blob }) => void

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = () => true

  state: 'inactive' | 'recording' = 'inactive'
  timeslice = 0
  ondataavailable: DataHandler | null = null
  onstop: (() => void) | null = null
  /** Queued to emit on stop(), mimicking MediaRecorder's async final chunk. */
  tailChunk: Blob | null = null

  constructor(
    readonly stream: MediaStream,
    readonly options: { mimeType: string },
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  static latest(): FakeMediaRecorder {
    const rec = FakeMediaRecorder.instances.at(-1)
    if (!rec) throw new Error('no MediaRecorder was constructed')
    return rec
  }

  static reset() {
    FakeMediaRecorder.instances = []
  }

  start(timeslice: number) {
    this.state = 'recording'
    this.timeslice = timeslice
  }

  /** Deliver one chunk, as a live timeslice would. */
  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob })
  }

  /**
   * The real contract: stop() returns immediately, the FINAL dataavailable fires
   * on a later task, and only then does `stop` fire. Reproducing that ordering is
   * the whole point -- flushing Deepgram before it drops the tail of every
   * utterance.
   */
  stop() {
    this.state = 'inactive'
    queueMicrotask(() => {
      if (this.tailChunk) this.emit(this.tailChunk)
      this.onstop?.()
    })
  }
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState: number = FakeWebSocket.CONNECTING
  sent: Array<Blob | string> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this)
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('no WebSocket was constructed')
    return ws
  }

  static reset() {
    FakeWebSocket.instances = []
  }

  send(data: Blob | string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  /** Transition to OPEN and fire the handler, as a real connect would. */
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  /** Push a Deepgram server message. */
  serverSend(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  /** Everything sent that was audio, in order. */
  audio(): Blob[] {
    return this.sent.filter((s): s is Blob => typeof s !== 'string')
  }

  /** Control-frame `type` values, in send order. */
  controlTypes(): string[] {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map(s => (JSON.parse(s) as { type: string }).type)
  }
}

/** A MediaStream stand-in -- the uplink only ever hands it to MediaRecorder. */
export function fakeStream(): MediaStream {
  return { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream
}

/** Install the fakes as globals. Returns a restore function. */
export function installVoiceFakes(): () => void {
  const prevRecorder = (globalThis as Record<string, unknown>).MediaRecorder
  const prevSocket = (globalThis as Record<string, unknown>).WebSocket
  FakeMediaRecorder.reset()
  FakeWebSocket.reset()
  ;(globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
  return () => {
    ;(globalThis as Record<string, unknown>).MediaRecorder = prevRecorder
    ;(globalThis as Record<string, unknown>).WebSocket = prevSocket
  }
}

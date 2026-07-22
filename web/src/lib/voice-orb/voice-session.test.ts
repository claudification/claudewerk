import { beforeEach, describe, expect, it, vi } from 'vitest'

// The transport is the one part that needs a browser -- stub it so the event
// pump (the part with logic) is testable end to end.
const sent: unknown[] = []
const transport = {
  send: (m: unknown) => sent.push(m),
  audioStreams: () => [],
  setMicEnabled: vi.fn(async () => {}),
  close: vi.fn(),
}
let handlers: { onOpen(): void; onMessage(raw: string): void; onClose(reason: string): void } | null = null
const connect = vi.fn(async (_token: unknown, h: typeof handlers) => {
  handlers = h
  return transport
})

vi.mock('./webrtc-transport', () => ({
  connectRealtime: (token: unknown, h: never) => connect(token, h),
}))

const { VoiceSession } = await import('./voice-session')

const TOKEN = { value: 'ek_1', model: 'gpt-realtime-2' }

function feed(ev: Record<string, unknown>) {
  handlers?.onMessage(JSON.stringify(ev))
}

beforeEach(() => {
  sent.length = 0
  handlers = null
  connect.mockClear()
  transport.close.mockClear()
})

async function startSession(over: Partial<Parameters<typeof makeHandlers>[0]> = {}) {
  const h = makeHandlers(over)
  const runTool = vi.fn(async () => ({ ok: true }))
  const session = new VoiceSession({ mintToken: async () => TOKEN, runTool }, h.handlers)
  await session.start()
  return { session, runTool, ...h }
}

function makeHandlers(over: Record<string, unknown> = {}) {
  const states: string[] = []
  const errors: string[] = []
  const lines: Array<[string, string, boolean]> = []
  const handlers = {
    onState: (s: string) => states.push(s),
    onError: (m: string) => errors.push(m),
    onTranscript: (role: string, text: string, partial: boolean) => lines.push([role, text, partial]),
    ...over,
  }
  return { handlers, states, errors, lines }
}

describe('VoiceSession lifecycle', () => {
  it('mints, connects, then greets first when the channel opens', async () => {
    const { states } = await startSession()
    expect(connect).toHaveBeenCalledWith(TOKEN, expect.anything())
    expect(states[0]).toBe('connecting')
    handlers?.onOpen()
    expect(states.at(-1)).toBe('listening')
    // The orb speaks first rather than waiting for the user.
    expect(sent).toEqual([{ type: 'response.create' }])
  })

  it('reports a mint failure instead of hanging on "connecting"', async () => {
    const { handlers: h, errors, states } = makeHandlers()
    const session = new VoiceSession(
      {
        mintToken: async () => {
          throw new Error('no OpenAI key')
        },
        runTool: async () => null,
      },
      h,
    )
    await expect(session.start()).rejects.toThrow('no OpenAI key')
    expect(errors[0]).toContain('no OpenAI key')
    expect(states.at(-1)).toBe('idle')
  })

  it('surfaces a transport drop as an error and tears down once', async () => {
    const { errors, states } = await startSession()
    handlers?.onClose('peer connection failed')
    expect(errors).toEqual(['peer connection failed'])
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toBe('idle')
    // A second drop after teardown must not re-fire.
    handlers?.onClose('data channel closed')
    expect(errors).toHaveLength(1)
  })
})

describe('VoiceSession event pump', () => {
  it('tracks turn state and relays transcripts', async () => {
    const { states, lines } = await startSession()
    feed({ type: 'response.created' })
    expect(states.at(-1)).toBe('speaking')
    feed({ type: 'response.output_audio_transcript.delta', delta: 'hi' })
    expect(lines.at(-1)).toEqual(['agent', 'hi', true])
    feed({ type: 'response.done', response: { output: [] } })
    expect(states.at(-1)).toBe('listening')
  })

  it('cancels the in-flight response on barge-in, and only then', async () => {
    await startSession()
    handlers?.onOpen()
    sent.length = 0
    // No active response -> nothing to cancel.
    feed({ type: 'input_audio_buffer.speech_started' })
    expect(sent).toEqual([])
    feed({ type: 'response.created' })
    feed({ type: 'input_audio_buffer.speech_started' })
    expect(sent).toEqual([{ type: 'response.cancel' }])
  })

  it('runs a tool call and feeds the output back with the call_id', async () => {
    const { runTool } = await startSession()
    handlers?.onOpen()
    sent.length = 0
    feed({
      type: 'response.done',
      response: {
        output: [{ type: 'function_call', id: 'i1', call_id: 'c1', name: 'projects_overview', arguments: '{}' }],
      },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(runTool).toHaveBeenCalledWith({ callId: 'c1', name: 'projects_overview', args: {} })
    expect(sent[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ ok: true }) },
    })
    expect(sent[1]).toEqual({ type: 'response.create' })
  })

  it('feeds a THROWN tool back as an error output -- the model must never stall', async () => {
    const h = makeHandlers()
    const session = new VoiceSession(
      {
        mintToken: async () => TOKEN,
        runTool: async () => {
          throw new Error('broker said no')
        },
      },
      h.handlers,
    )
    await session.start()
    handlers?.onOpen()
    sent.length = 0
    feed({
      type: 'response.done',
      response: { output: [{ type: 'function_call', id: 'i1', call_id: 'c9', name: 'x', arguments: '{}' }] },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(JSON.stringify(sent[0])).toContain('broker said no')
  })

  it('relays realtime errors and ignores junk', async () => {
    const { errors } = await startSession()
    handlers?.onMessage('not json')
    feed({ type: 'something.unknown' })
    expect(errors).toEqual([])
    feed({ type: 'error', error: { message: 'rate limited' } })
    expect(errors).toEqual(['rate limited'])
  })
})

describe('VoiceSession teardown', () => {
  it('closes the transport once and reports idle', async () => {
    const { session, states } = await startSession()
    session.close()
    session.close()
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toBe('idle')
  })

  it('forwards mute to the transport and survives with no session', async () => {
    const { session } = await startSession()
    await session.setMicEnabled(false)
    expect(transport.setMicEnabled).toHaveBeenCalledWith(false)
    session.close()
    await expect(session.setMicEnabled(true)).resolves.toBeUndefined()
    expect(session.audioStreams()).toEqual([])
  })
})

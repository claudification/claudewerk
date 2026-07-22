import { describe, expect, it } from 'bun:test'
import type { RealtimeTool } from './realtime-schema'
import { buildVoiceSessionConfig, mintVoiceToken, REALTIME_MODEL } from './voice-mint'

/** A stand-in contract -- the real one is derived from a live runtime and is
 *  covered by voice-tools.test.ts; the mint only has to carry what it is given. */
const TOOLS: RealtimeTool[] = [
  {
    type: 'function',
    name: 'projects_overview',
    description: 'the fleet by project',
    parameters: { type: 'object', strict: true, properties: {}, required: [], additionalProperties: false },
  },
]

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('buildVoiceSessionConfig', () => {
  it('wires the supplied contract + realtime model', () => {
    const cfg = buildVoiceSessionConfig(TOOLS)
    expect(cfg.model).toBe(REALTIME_MODEL)
    expect(cfg.tools.map(t => t.name)).toEqual(['projects_overview'])
    expect(cfg.audio.output.voice).toBeTruthy()
  })

  it('composes the persona from the minted tool names', () => {
    expect(buildVoiceSessionConfig(TOOLS).instructions).toContain('`projects_overview`')
    // No `dispatch` in the contract -> the persona must not coach it.
    expect(buildVoiceSessionConfig(TOOLS).instructions).not.toContain('`dispatch`')
  })

  it('mints at the requested tone, snarky by default', () => {
    expect(buildVoiceSessionConfig(TOOLS).instructions).toContain('meatbag')
    expect(buildVoiceSessionConfig(TOOLS, { tone: 'professional' }).instructions).not.toContain('meatbag')
  })

  it('mints at the requested speaking rate, clamped to the API range', () => {
    const speedOf = (cfg: ReturnType<typeof buildVoiceSessionConfig>) => cfg.audio.output.speed
    expect(speedOf(buildVoiceSessionConfig(TOOLS, { speed: 1.4 }))).toBe(1.4)
    // 1.6 is a hard 400 from OpenAI -- clamp rather than mint a broken session.
    expect(speedOf(buildVoiceSessionConfig(TOOLS, { speed: 1.6 }))).toBe(1.5)
    expect(speedOf(buildVoiceSessionConfig(TOOLS, { speed: 0.05 }))).toBe(0.25)
    expect(speedOf(buildVoiceSessionConfig(TOOLS, { speed: Number.NaN }))).toBe(1.3)
    expect(speedOf(buildVoiceSessionConfig(TOOLS))).toBe(1.3)
  })

  it('honours an explicit instructions override', () => {
    expect(buildVoiceSessionConfig(TOOLS, { instructions: 'be brief' }).instructions).toBe('be brief')
  })
})

describe('mintVoiceToken -- key protection', () => {
  it('mints an ephemeral token without leaking the key to the result', async () => {
    let sentAuth = ''
    let sentUrl = ''
    const fetcher = (async (url: string, init: RequestInit) => {
      sentUrl = String(url)
      sentAuth = String((init.headers as Record<string, string>).Authorization)
      return jsonResponse({ client_secret: { value: 'ek_ephemeral_123', expires_at: 999 } })
    }) as unknown as typeof fetch

    const out = await mintVoiceToken({ apiKey: 'sk-secret', tools: TOOLS, fetcher, safetyId: 'desk-jonas' })
    expect(out.value).toBe('ek_ephemeral_123')
    expect(out.expiresAt).toBe(999)
    expect(out.model).toBe(REALTIME_MODEL)
    // The secret key went ONLY in the server->OpenAI Authorization header.
    expect(sentAuth).toBe('Bearer sk-secret')
    expect(sentUrl).toContain('openai.com/v1/realtime/client_secrets')
    expect(JSON.stringify(out)).not.toContain('sk-secret')
  })

  it('returns the EXACT audio block it minted, for later session.updates', async () => {
    let sentBody: Record<string, unknown> = {}
    const fetcher = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return jsonResponse({ client_secret: { value: 'ek_1' } })
    }) as unknown as typeof fetch

    const out = await mintVoiceToken({ apiKey: 'sk', tools: TOOLS, fetcher, voice: 'ash', speed: 1.4 })
    const session = sentBody.session as { audio: unknown }
    // What comes back must be what went in -- the client echoes it verbatim on
    // an update, so a drift here silently reconfigures the live session.
    expect(out.audio).toEqual(session.audio)
    expect(out.audio).toMatchObject({ output: { voice: 'ash', speed: 1.4 } })
    expect(out.audio).toHaveProperty('input.transcription')
    expect(out.audio).toHaveProperty('input.turn_detection')
  })

  it('supports the flat {value} response shape too', async () => {
    const fetcher = (async () => jsonResponse({ value: 'ek_flat' })) as unknown as typeof fetch
    const out = await mintVoiceToken({ apiKey: 'sk', tools: TOOLS, fetcher })
    expect(out.value).toBe('ek_flat')
  })

  it('throws a clear error when the key is missing', async () => {
    await expect(mintVoiceToken({ apiKey: '', tools: TOOLS })).rejects.toThrow('OPENAI_API_KEY not configured')
  })

  it('surfaces an OpenAI error status', async () => {
    const fetcher = (async () => jsonResponse({ error: 'nope' }, false, 401)) as unknown as typeof fetch
    await expect(mintVoiceToken({ apiKey: 'sk', tools: TOOLS, fetcher })).rejects.toThrow('client_secrets 401')
  })

  it('throws when no token is present', async () => {
    const fetcher = (async () => jsonResponse({})) as unknown as typeof fetch
    await expect(mintVoiceToken({ apiKey: 'sk', tools: TOOLS, fetcher })).rejects.toThrow('no token')
  })
})

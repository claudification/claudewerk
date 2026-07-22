/**
 * Jarvis voice token-mint (plan-dispatcher-build.md §5 item 6 + §6).
 *
 * KEY PROTECTION (non-negotiable): the real `OPENAI_API_KEY` NEVER reaches the
 * browser. This runs server-side (broker), mints a short-lived ephemeral client
 * secret (`ek-...`, ~1h TTL) via OpenAI's client_secrets endpoint, and the
 * browser gets ONLY that ephemeral token to Bearer on its WebRTC SDP offer.
 *
 * Mirrors the protokol interview-poc `mintClientSecret` + `buildSessionConfig`
 * (verified against developers.openai.com, 2026-06). The session is wired with
 * the dispatch tool contract (voice-tools.ts) so the model can DRIVE dispatch.
 *
 * `apiKey` and `fetcher` are parameters (not read here) so this is unit-tested
 * without network and the route owns where the key comes from (process.env).
 */

import type { RealtimeTool } from './realtime-schema'
import { buildVoiceInstructions } from './voice-persona'

export const REALTIME_MODEL = 'gpt-realtime-2'
const VOICE = 'marin'
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets'

/** The session is configured AT MINT (a client `session.update` after connect
 *  does not apply consistently). `tools` is the phase's voice contract; the
 *  persona is composed from those same names so it never coaches a verb the
 *  contract does not offer. */
export function buildVoiceSessionConfig(tools: RealtimeTool[], instructions?: string) {
  return {
    type: 'realtime' as const,
    model: REALTIME_MODEL,
    instructions: instructions ?? buildVoiceInstructions(tools.map(t => t.name)),
    audio: {
      input: {
        transcription: { model: 'whisper-1' },
        turn_detection: { type: 'semantic_vad', eagerness: 'medium' as const },
      },
      output: { voice: VOICE },
    },
    tools,
    tool_choice: 'auto' as const,
  }
}

export interface MintedVoiceToken {
  value: string
  model: string
  expiresAt?: number
}

export interface MintVoiceOptions {
  /** The OpenAI secret key -- supplied server-side from process.env, never the browser. */
  apiKey: string
  /** The phase's voice contract (voice-tools.ts `voiceRealtimeTools`). Explicit --
   *  there is no default, so a caller can never accidentally mint the wide set. */
  tools: RealtimeTool[]
  /** Test seam. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
  /** Override the session instructions (default: composed from `tools`). */
  instructions?: string
  /** OpenAI-Safety-Identifier (e.g. `desk-<userId>`). */
  safetyId?: string
}

export async function mintVoiceToken(opts: MintVoiceOptions): Promise<MintedVoiceToken> {
  if (!opts.apiKey) throw new Error('OPENAI_API_KEY not configured')
  const fetcher = opts.fetcher ?? globalThis.fetch

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  }
  if (opts.safetyId) headers['OpenAI-Safety-Identifier'] = opts.safetyId

  const res = await fetcher(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session: buildVoiceSessionConfig(opts.tools, opts.instructions) }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`client_secrets ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    client_secret?: { value: string; expires_at?: number }
    value?: string
  }
  const value = data.client_secret?.value ?? data.value
  if (!value) throw new Error('client_secrets: no token in response')
  return { value, model: REALTIME_MODEL, expiresAt: data.client_secret?.expires_at }
}

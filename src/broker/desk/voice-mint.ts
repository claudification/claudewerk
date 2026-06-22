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

import { voiceTools } from './voice-tools'

export const REALTIME_MODEL = 'gpt-realtime-2'
const VOICE = 'marin'
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets'

/** Jarvis's standing instructions -- it is the fleet's voice dispatcher. */
export const VOICE_INSTRUCTIONS = [
  "You are Jarvis, the voice dispatcher for the user's fleet of coding conversations.",
  'You DRIVE the system by calling tools -- you do not just talk.',
  'When the user expresses an intent, call `dispatch` with it and let the dispatcher',
  'decide whether to spawn a new conversation, route into an existing one, or revive',
  'an ended one. Only pass target/disposition when the user is explicit.',
  'If the dispatcher asks the user to choose between conversations, read the top',
  'candidates aloud and call `conversation_select` with their pick. If it warns a',
  'route is very expensive, state the cost plainly and call `confirm_expensive` with',
  'their yes/no. Use `control_screen` to open/close modals or navigate when asked.',
  '',
  'VOICE IS LOSSY -- transcription mangles PRECISE details: email addresses, phone',
  'numbers, IDs, names, URLs, file paths, amounts. NEVER pass these through to a',
  'tool unconfirmed. Read the value back and get an explicit confirmation first',
  '(and once the input-prompt UI tool ships, use it to show the parsed value for',
  'the user to verify/correct before you act). Free-form prose is fine as-is; it',
  'is only the exact-string details that must be confirmed.',
  '',
  'Be concise. One action at a time. Confirm what you did in a short spoken line.',
].join('\n')

export function buildVoiceSessionConfig(instructions: string = VOICE_INSTRUCTIONS) {
  return {
    type: 'realtime' as const,
    model: REALTIME_MODEL,
    instructions,
    audio: {
      input: {
        transcription: { model: 'whisper-1' },
        turn_detection: { type: 'semantic_vad', eagerness: 'medium' as const },
      },
      output: { voice: VOICE },
    },
    tools: voiceTools,
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
  /** Test seam. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
  /** Override the session instructions. */
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
    body: JSON.stringify({ session: buildVoiceSessionConfig(opts.instructions) }),
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

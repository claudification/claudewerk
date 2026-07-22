/**
 * Everything it takes to bring one voice session up, in one place and OUT of
 * React: the lazy chunk imports, the tool bridge (with its client-local verbs),
 * and the session wired to the caller's callbacks.
 *
 * LAZY LOAD lives here: this module is itself imported dynamically by the hook,
 * so the WebRTC path only enters the bundle graph on the first summon.
 */

import type { VoiceOrbTone } from '@/components/voice-orb/voice-orb-tone'
import { getOrbInstanceId } from './orb-instance'
import type { FunctionCall, VoiceState } from './realtime-events'
import type { ToolBridge } from './tool-bridge'
import type { VoiceSession } from './voice-session'

export interface OpenSessionCallbacks {
  onState(state: VoiceState): void
  onError(message: string): void
  onTranscript(role: 'agent' | 'user', text: string, partial: boolean): void
  /** The model asked to restart itself. */
  onReload(): void
  /** Wire sender for non-local tools. */
  send(type: string, data: Record<string, unknown>): void
  /** The tone dial's current position -- baked into the session at mint. */
  tone(): VoiceOrbTone | string
  /** Speaking rate at mint time (0.25..1.5). */
  speed(): number
  /** Which OpenAI voice speaks. */
  voice(): string
}

export interface OpenSession {
  session: VoiceSession
  bridge: ToolBridge
}

/** How long the orb gets to finish its sentence before a self-reload cuts it
 *  off. Long enough for "fine, rebooting", short enough not to feel hung. */
const RELOAD_GRACE_MS = 1200

async function mintToken(opts: {
  tone: string
  speed: number
  voice: string
  orbId: string
}): Promise<{ value: string; model: string }> {
  const res = await fetch('/api/desk/voice/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    if (body.code === 'voice_unconfigured') throw new Error('the broker has no OpenAI key configured')
    throw new Error(body.error ?? `mint failed (${res.status})`)
  }
  return (await res.json()) as { value: string; model: string }
}

/** Build + start a live session. Throws if the mint or the handshake fails;
 *  the caller is responsible for tearing down what it gets back. */
export async function openVoiceSession(cb: OpenSessionCallbacks): Promise<OpenSession> {
  const [{ createToolBridge, setActiveToolBridge }, { VoiceSession: Session }, { runControlScreen }] =
    await Promise.all([import('./tool-bridge'), import('./voice-session'), import('./control-screen')])
  const { runSayToConversation } = await import('./say-to-conversation')

  const bridge = createToolBridge({
    send: cb.send,
    local: {
      control_screen: args => runControlScreen(args),
      // The direct path: his words, to the conversation he means.
      say_to_conversation: args => runSayToConversation(args),
      // Answered immediately and acted on after a beat, so the orb's last
      // words make it out before the session is torn down under it.
      reload_yourself: () => {
        setTimeout(cb.onReload, RELOAD_GRACE_MS)
        return { reloading: true }
      },
    },
  })
  setActiveToolBridge(bridge)

  const session = new Session(
    {
      mintToken: () =>
        mintToken({ tone: String(cb.tone()), speed: cb.speed(), voice: cb.voice(), orbId: getOrbInstanceId() }),
      runTool: (call: FunctionCall) => bridge.run(call),
    },
    { onState: cb.onState, onError: cb.onError, onTranscript: cb.onTranscript },
  )
  await session.start()
  return { session, bridge }
}

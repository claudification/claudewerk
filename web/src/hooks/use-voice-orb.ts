/**
 * The voice orb's React glue: summon -> live realtime session -> un-summon.
 *
 * LAZY LOAD: the WebRTC transport, the session and the tool bridge are pulled in
 * with a dynamic `import()` on the FIRST summon, so none of that code ships in
 * the index bundle. This hook itself only lives inside the already-lazy orb
 * host, and holds no heavy static imports.
 *
 * The orb never composes instructions or tools -- the broker bakes both into the
 * minted token (voice-tools.ts is the contract). The client half is: mint,
 * connect, pump events, execute the client-local verbs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { wsSend } from '@/hooks/use-conversations'
import type { VoiceState } from '@/lib/voice-orb/realtime-events'
import type { ToolBridge } from '@/lib/voice-orb/tool-bridge'
import type { VoiceSession } from '@/lib/voice-orb/voice-session'

export interface VoiceOrbLine {
  role: 'agent' | 'user'
  text: string
  partial: boolean
}

export interface VoiceOrb {
  state: VoiceState
  error: string | null
  /** The most recent spoken line either way -- the orb's caption. */
  lastLine: VoiceOrbLine | null
  muted: boolean
  live: boolean
  start(): Promise<void>
  stop(): void
  toggleMute(): void
  /** Tear down and restart with a fresh session (the `reload_yourself` verb). */
  reload(): Promise<void>
  /** Live mic + remote streams for the orb's audio reactivity. */
  audioStreams(): MediaStream[]
}

async function mintToken(): Promise<{ value: string; model: string }> {
  const res = await fetch('/api/desk/voice/token', { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    if (body.code === 'voice_unconfigured') throw new Error('the broker has no OpenAI key configured')
    throw new Error(body.error ?? `mint failed (${res.status})`)
  }
  return (await res.json()) as { value: string; model: string }
}

export function useVoiceOrb(): VoiceOrb {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastLine, setLastLine] = useState<VoiceOrbLine | null>(null)
  const [muted, setMuted] = useState(false)

  const sessionRef = useRef<VoiceSession | null>(null)
  const bridgeRef = useRef<ToolBridge | null>(null)
  const startingRef = useRef(false)
  // A reload must not be mistaken for the user closing the orb.
  const reloadingRef = useRef(false)

  const stop = useCallback(() => {
    sessionRef.current?.close()
    sessionRef.current = null
    bridgeRef.current?.dispose()
    bridgeRef.current = null
    void import('@/lib/voice-orb/tool-bridge').then(m => m.setActiveToolBridge(null))
    setState('idle')
    setMuted(false)
  }, [])

  const start = useCallback(async () => {
    if (sessionRef.current || startingRef.current) return
    startingRef.current = true
    setError(null)
    setState('connecting')
    try {
      const [{ createToolBridge, setActiveToolBridge }, { VoiceSession: Session }, { runControlScreen }] =
        await Promise.all([
          import('@/lib/voice-orb/tool-bridge'),
          import('@/lib/voice-orb/voice-session'),
          import('@/lib/voice-orb/control-screen'),
        ])

      const bridge = createToolBridge({
        send: (type, data) => wsSend(type, data),
        local: {
          control_screen: args => runControlScreen(args),
          // Answered here AND acted on after the model hears it, so its last
          // words make it out before the session is torn down.
          reload_yourself: () => {
            setTimeout(() => void reloadRef.current(), 1200)
            return { reloading: true }
          },
        },
      })
      setActiveToolBridge(bridge)
      bridgeRef.current = bridge

      const session = new Session(
        { mintToken, runTool: call => bridge.run(call) },
        {
          onState: setState,
          onError: msg => setError(msg),
          onTranscript: (role, text, partial) => setLastLine({ role, text, partial }),
        },
      )
      sessionRef.current = session
      await session.start()
    } catch (e) {
      setError((e as Error).message)
      stop()
    } finally {
      startingRef.current = false
    }
  }, [stop])

  const reload = useCallback(async () => {
    reloadingRef.current = true
    stop()
    try {
      await start()
    } finally {
      reloadingRef.current = false
    }
  }, [start, stop])
  // `start` closes over reload; a ref breaks the cycle without re-creating either.
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  const toggleMute = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    const next = !muted
    setMuted(next)
    void session.setMicEnabled(!next)
  }, [muted])

  const audioStreams = useCallback(() => sessionRef.current?.audioStreams() ?? [], [])

  // Releasing the mic is not optional -- unmounting with a live session leaves
  // the OS capture indicator on.
  useEffect(() => stop, [stop])

  return {
    state,
    error,
    lastLine,
    muted,
    live: state !== 'idle',
    start,
    stop,
    toggleMute,
    reload,
    audioStreams,
  }
}

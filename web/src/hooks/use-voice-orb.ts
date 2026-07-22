/**
 * The voice orb's React glue: summon -> live realtime session -> un-summon.
 *
 * State only. Every moving part (the lazy chunk imports, the tool bridge, the
 * mint, the session) lives in lib/voice-orb/open-session.ts, which is itself
 * pulled in dynamically -- so none of the WebRTC path ships in the index bundle
 * and this file stays a readable state machine.
 *
 * The orb never composes instructions or tools: the broker bakes both into the
 * minted token (voice-tools.ts is the contract).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import type { OpenSession } from '@/lib/voice-orb/open-session'
import type { VoiceState } from '@/lib/voice-orb/realtime-events'

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
  /** Make the orb volunteer something (proactive fleet narration). */
  announce(note: string): void
}

export function useVoiceOrb(): VoiceOrb {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastLine, setLastLine] = useState<VoiceOrbLine | null>(null)
  const [muted, setMuted] = useState(false)

  const liveRef = useRef<OpenSession | null>(null)
  const startingRef = useRef(false)

  const stop = useCallback(() => {
    liveRef.current?.session.close()
    liveRef.current?.bridge.dispose()
    liveRef.current = null
    void import('@/lib/voice-orb/tool-bridge').then(m => m.setActiveToolBridge(null))
    setState('idle')
    setMuted(false)
  }, [])

  // `start` triggers reload (via the model's own verb) and reload calls start;
  // the ref breaks the cycle without re-creating either callback.
  const reloadRef = useRef<() => void>(() => {})

  const start = useCallback(async () => {
    if (liveRef.current || startingRef.current) return
    startingRef.current = true
    setError(null)
    setState('connecting')
    try {
      const { openVoiceSession } = await import('@/lib/voice-orb/open-session')
      liveRef.current = await openVoiceSession({
        onState: setState,
        onError: setError,
        onTranscript: (role, text, partial) => setLastLine({ role, text, partial }),
        onReload: () => reloadRef.current(),
        send: wsSend,
        tone: () => useConversationsStore.getState().controlPanelPrefs.voiceOrbTone,
      })
    } catch (e) {
      setError((e as Error).message)
      stop()
    } finally {
      startingRef.current = false
    }
  }, [stop])

  const reload = useCallback(async () => {
    stop()
    await start()
  }, [start, stop])
  reloadRef.current = () => void reload()

  const toggleMute = useCallback(() => {
    if (!liveRef.current) return
    const next = !muted
    setMuted(next)
    void liveRef.current.session.setMicEnabled(!next)
  }, [muted])

  const audioStreams = useCallback(() => liveRef.current?.session.audioStreams() ?? [], [])
  const announce = useCallback((note: string) => liveRef.current?.session.announce(note), [])

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
    announce,
  }
}

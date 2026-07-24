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
import { orbSpeed, useOrbLiveSettings } from '@/hooks/use-orb-live-settings'
import { useWakeLock } from '@/hooks/use-wake-lock'
import { foldCaption, type SpokenLine } from '@/lib/voice-orb/caption-fold'
import type { OpenSession } from '@/lib/voice-orb/open-session'
import type { VoiceState } from '@/lib/voice-orb/realtime-events'
import { appendLine, foldLog, typedLine } from '@/lib/voice-orb/transcript-log'

export interface VoiceOrb {
  state: VoiceState
  error: string | null
  /** The most recent spoken line either way -- the orb's caption. */
  lastLine: SpokenLine | null
  /** The whole session, both sides, oldest first -- what the panel scrolls. */
  lines: SpokenLine[]
  muted: boolean
  live: boolean
  start(): Promise<void>
  stop(): void
  toggleMute(): void
  /** Live mic + remote streams for the orb's audio reactivity. */
  audioStreams(): MediaStream[]
  /** Make the orb volunteer something (proactive fleet narration). */
  announce(note: string): void
  /**
   * Say something to the orb WITHOUT the mic -- the typed path, for pasting an
   * id or a URL that voice would mangle. Same wire event as `announce`; the
   * difference is that a typed line is HIS, so it enters the transcript
   * immediately instead of waiting on a transcription that never comes.
   */
  say(text: string): void
}

/** The orb session, as a hook. RESTART is not a method here -- it is a REMOUNT:
 *  the host keys this hook's component on a generation counter and bumps it, so
 *  a restart fully tears the session down (mic + audio sink + analyser + every
 *  ref) and stands a clean one up. `onReloadRequest` is how the things that live
 *  INSIDE the session (the model's `reload_yourself`, a voice change) ask the
 *  host for that remount. */
export function useVoiceOrb(opts: { onReloadRequest: () => void }): VoiceOrb {
  const { onReloadRequest } = opts
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastLine, setLastLine] = useState<SpokenLine | null>(null)
  const [lines, setLines] = useState<SpokenLine[]>([])
  const [muted, setMuted] = useState(false)

  const liveRef = useRef<OpenSession | null>(null)
  const startingRef = useRef(false)
  // False once we unmount. A restart remounts fast, so a session can finish
  // connecting AFTER this instance is gone -- without this it leaks a live
  // session and a hot mic that nothing will ever close.
  const mountedRef = useRef(true)

  const stop = useCallback(() => {
    const gone = liveRef.current
    gone?.session.close()
    gone?.bridge.dispose()
    liveRef.current = null
    // Compare-and-clear: on a restart a fresh session mounts while this clear is
    // still awaiting its import, so only clear if we are still the active one.
    void import('@/lib/voice-orb/tool-bridge').then(m => m.setActiveToolBridge(null, gone?.bridge))
    setState('idle')
    setMuted(false)
    // The realtime conversation is GONE -- keeping its transcript on screen
    // would read as scrollback the orb still remembers. It does not.
    setLines([])
  }, [])

  const start = useCallback(async () => {
    if (liveRef.current || startingRef.current) return
    startingRef.current = true
    setError(null)
    setState('connecting')
    try {
      const { openVoiceSession } = await import('@/lib/voice-orb/open-session')
      const session = await openVoiceSession({
        onState: setState,
        onError: setError,
        // Deltas are FRAGMENTS -- fold them, never display one as the line.
        onTranscript: (role, text, partial) => {
          setLastLine(prev => foldCaption(prev, { role, text, partial }))
          setLines(prev => foldLog(prev, { role, text, partial }))
        },
        // The model's `reload_yourself` verb -- ask the host to remount us.
        onReload: onReloadRequest,
        send: wsSend,
        tone: () => useConversationsStore.getState().controlPanelPrefs.voiceOrbTone,
        speed: () => orbSpeed(),
        voice: () => useConversationsStore.getState().controlPanelPrefs.voiceOrbVoice,
      })
      // Unmounted while we were connecting (a fast restart): tear the fresh
      // session down at once instead of leaving it live and orphaned.
      if (!mountedRef.current) {
        session.session.close()
        session.bridge.dispose()
        void import('@/lib/voice-orb/tool-bridge').then(m => m.setActiveToolBridge(null, session.bridge))
        return
      }
      liveRef.current = session
    } catch (e) {
      setError((e as Error).message)
      stop()
    } finally {
      startingRef.current = false
    }
  }, [stop, onReloadRequest])

  const toggleMute = useCallback(() => {
    if (!liveRef.current) return
    const next = !muted
    setMuted(next)
    void liveRef.current.session.setMicEnabled(!next)
  }, [muted])

  // A voice change cannot apply to a live session -- it re-mints via a remount.
  useOrbLiveSettings(liveRef.current, onReloadRequest)

  // Keep the screen awake for the whole live span (connecting..speaking): the
  // user is talking to the orb, not tapping, so let the phone not dim or lock.
  useWakeLock(state !== 'idle')

  const audioStreams = useCallback(() => liveRef.current?.session.audioStreams() ?? [], [])
  const announce = useCallback((note: string) => liveRef.current?.session.announce(note), [])

  // Typed text rides the SAME wire event as a narration note (a `role: user`
  // input_text item plus a turn request) -- the only difference is that this
  // one is his, so it goes in the transcript here. Nothing transcribes a
  // keystroke, and a message that vanished on send would look like a drop.
  const say = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !liveRef.current) return
    setLines(prev => appendLine(prev, typedLine(trimmed)))
    liveRef.current.session.announce(trimmed)
  }, [])

  // The session starts on MOUNT and stops on UNMOUNT: mounting this hook's
  // component IS the summon, and a restart is a remount, so this is the whole
  // lifecycle. Releasing the mic on unmount is not optional -- leaving a live
  // session behind keeps the OS capture indicator on. `start` no-ops if a
  // session is already up, so a benign re-run is harmless.
  useEffect(() => {
    mountedRef.current = true
    void start()
    return () => {
      mountedRef.current = false
      stop()
    }
  }, [start, stop])

  return {
    state,
    error,
    lastLine,
    lines,
    muted,
    live: state !== 'idle',
    start,
    stop,
    toggleMute,
    audioStreams,
    announce,
    say,
  }
}

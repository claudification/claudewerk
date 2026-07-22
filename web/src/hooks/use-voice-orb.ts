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
  /** Tear down and restart with a fresh session (the `reload_yourself` verb). */
  reload(): Promise<void>
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

/** The dial's current position, clamped to what the API accepts. */
function orbSpeed(): number {
  const raw = Number(useConversationsStore.getState().controlPanelPrefs.voiceOrbSpeed)
  if (!Number.isFinite(raw)) return 1.3
  return Math.min(1.5, Math.max(0.25, raw))
}

/** Push speed + voice prefs to the LIVE session whenever they move (from the
 *  pickers or the orb's own `update_orb_settings`). One hook so the main one
 *  stays a flat state machine. Voice skips its first run so it never re-sends
 *  the voice the session was just minted with. */
function useLiveSettings(live: { session: { setSpeed(n: number): void; setVoice(v: string): void } } | null): void {
  const speed = useConversationsStore(st => st.controlPanelPrefs.voiceOrbSpeed)
  const voice = useConversationsStore(st => st.controlPanelPrefs.voiceOrbVoice)
  const voiceMounted = useRef(false)
  useEffect(() => {
    live?.session.setSpeed(orbSpeed())
  }, [speed, live])
  useEffect(() => {
    if (!live) {
      voiceMounted.current = false
      return
    }
    if (!voiceMounted.current) {
      voiceMounted.current = true
      return
    }
    live.session.setVoice(voice)
  }, [voice, live])
}

export function useVoiceOrb(): VoiceOrb {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastLine, setLastLine] = useState<SpokenLine | null>(null)
  const [lines, setLines] = useState<SpokenLine[]>([])
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
    // The realtime conversation is GONE -- keeping its transcript on screen
    // would read as scrollback the orb still remembers. It does not.
    setLines([])
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
        // Deltas are FRAGMENTS -- fold them, never display one as the line.
        onTranscript: (role, text, partial) => {
          setLastLine(prev => foldCaption(prev, { role, text, partial }))
          setLines(prev => foldLog(prev, { role, text, partial }))
        },
        onReload: () => reloadRef.current(),
        send: wsSend,
        tone: () => useConversationsStore.getState().controlPanelPrefs.voiceOrbTone,
        speed: () => orbSpeed(),
        voice: () => useConversationsStore.getState().controlPanelPrefs.voiceOrbVoice,
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

  useLiveSettings(liveRef.current)

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

  // Releasing the mic is not optional -- unmounting with a live session leaves
  // the OS capture indicator on.
  useEffect(() => stop, [stop])

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
    reload,
    audioStreams,
    announce,
    say,
  }
}

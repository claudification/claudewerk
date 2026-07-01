/**
 * AudioPlayer - persistent floating mini-player docked at the top of the chrome.
 *
 * Lazy-loaded (audio-player-host.tsx) on first play, so this chunk + the <audio>
 * element only cost something once the user actually plays a track. Holds the
 * single <audio> for the whole app: switching conversations or scrolling never
 * interrupts playback, and only one track plays at a time (loading a new track
 * just swaps the src).
 *
 * Controls: play/pause, seek scrubber, current/total time, track label, close.
 */

import { Pause, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn, haptic } from '@/lib/utils'
import { useAudioPlayer } from './audio-player-bus'

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function AudioPlayer() {
  const { track, close } = useAudioPlayer()
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  // New track -> load + autoplay. The play() is user-initiated (chip tap), so
  // browser autoplay policy permits it; .catch swallows the rare rejection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: track.url is the load key
  useEffect(() => {
    const el = audioRef.current
    if (!el || !track) return
    setCurrent(0)
    setDuration(0)
    el.load()
    el.play().catch(() => {
      /* autoplay blocked / interrupted -- user can hit play */
    })
  }, [track?.url])

  if (!track) return null

  function toggle() {
    const el = audioRef.current
    if (!el) return
    haptic('tap')
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current
    if (!el) return
    el.currentTime = Number(e.target.value)
    setCurrent(el.currentTime)
  }

  return (
    <div
      className={cn(
        'fixed top-2 left-1/2 -translate-x-1/2 z-[90]',
        'w-[min(92vw,30rem)] flex items-center gap-2.5 px-3 py-2',
        'rounded-lg border border-border/60 bg-background/95 backdrop-blur shadow-2xl',
      )}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: user-supplied audio, no captions */}
      <audio
        ref={audioRef}
        src={track.url}
        aria-label="Audio player"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
      >
        <track kind="captions" />
      </audio>

      <button
        type="button"
        onClick={toggle}
        className="shrink-0 flex items-center justify-center size-8 rounded-full bg-accent text-accent-foreground hover:opacity-90 transition-opacity"
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="truncate text-xs font-mono text-foreground/90" title={track.label}>
          {track.label}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={current}
            onChange={seek}
            aria-label="Seek"
            className="flex-1 h-1 accent-accent cursor-pointer"
          />
          <span className="shrink-0 text-[10px] font-mono text-muted-foreground tabular-nums">
            {fmt(current)} / {fmt(duration)}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          haptic('tick')
          close()
        }}
        className="shrink-0 flex items-center justify-center size-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        title="Close player"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

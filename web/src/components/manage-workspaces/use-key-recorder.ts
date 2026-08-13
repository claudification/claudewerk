/**
 * Record a key binding by pressing it.
 *
 * The whole key-layer stack is SUSPENDED while recording (setKeyLayersSuspended)
 * -- otherwise the combo being recorded would fire whatever it is currently
 * bound to on its way past, and a binding already owned by a layer that calls
 * stopImmediatePropagation would never reach this recorder at all.
 *
 * Two segments max, so a chord ('mod+g w') can be recorded as well as a plain
 * combo. A short pause after the last complete segment commits.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeEvent, setKeyLayersSuspended } from '@/lib/key-layers'

/** Pause after the last keystroke before the recording is taken as final. */
const COMMIT_DELAY_MS = 900
const MAX_SEGMENTS = 2

/** A pattern that is only modifiers ('mod', 'mod+shift') is a key still in
 *  flight, not a binding -- the user is holding Cmd and hasn't hit the key yet. */
function isComplete(pattern: string): boolean {
  const last = pattern.split('+').pop() ?? ''
  return last.length > 0 && !['mod', 'ctrl', 'alt', 'shift', 'meta'].includes(last)
}

export interface KeyRecorder {
  recording: boolean
  /** Segments captured so far, joined -- render this as the live preview. */
  draft: string
  start: () => void
  cancel: () => void
}

export function useKeyRecorder(onCommit: (binding: string) => void): KeyRecorder {
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState('')
  const segments = useRef<string[]>([])
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const stop = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = null
    segments.current = []
    setDraft('')
    setRecording(false)
  }, [])

  const start = useCallback(() => {
    segments.current = []
    setDraft('')
    setRecording(true)
  }, [])

  useEffect(() => {
    if (!recording) return
    setKeyLayersSuspended(true)

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return stop()

      const pattern = normalizeEvent(e)
      if (!isComplete(pattern)) return

      segments.current = [...segments.current, pattern].slice(-MAX_SEGMENTS)
      const next = segments.current.join(' ')
      setDraft(next)

      if (commitTimer.current) clearTimeout(commitTimer.current)
      commitTimer.current = setTimeout(() => {
        onCommitRef.current(next)
        stop()
      }, COMMIT_DELAY_MS)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      setKeyLayersSuspended(false)
    }
  }, [recording, stop])

  return { recording, draft, start, cancel: stop }
}

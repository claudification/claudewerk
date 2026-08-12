/**
 * useMicPermission - one implementation of "may we open the mic yet?", shared by
 * every voice trigger.
 *
 * THE INCIDENT (2026-08-12, iPad): the FAB owned a private copy of this logic
 * and the push-to-talk key owned none at all -- pressing Right Option dived
 * straight into the recording state machine, so a platform refusal surfaced as
 * WebKit's raw DOMException in the banner instead of an unlock prompt. Two
 * triggers, two behaviours, one of them wrong. There is now one.
 *
 * THE SAFARI RULE THAT SHAPES THIS FILE: `permissions.query({microphone})` is
 * not authoritative. Measured on iPadOS 26 that day, it reported `prompt` for
 * the whole session -- before a grant, during a working recording, and after a
 * refusal. So a query result may DOWNGRADE us only to `denied`; a grant we
 * proved by actually opening the device outranks anything the query says, or
 * every app switch would demand a fresh unlock tap.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { openPreferredMicStream } from '@/hooks/voice-mic-stream'
import { describeMicError } from '@/lib/mic-error'

export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied'

export interface MicPermissionResult {
  state: MicPermission
  /** No grant yet: a press must unlock before it may start recording. */
  needsUnlock: boolean
  /** Probe for a grant. MUST be called inside a user gesture. */
  unlock: () => Promise<boolean>
  /** Human text for the last unlock failure, '' when there was none. */
  error: string
  /** Drop the last unlock failure text (the UI auto-dismisses it). */
  clearError: () => void
}

function queryMicPermission(): Promise<MicPermission | null> {
  const permissions = navigator.permissions
  if (!permissions?.query) return Promise.resolve(null)
  return permissions
    .query({ name: 'microphone' as PermissionName })
    .then(status => status.state as MicPermission)
    .catch(() => null)
}

export function useMicPermission(): MicPermissionResult {
  const [state, setState] = useState<MicPermission>('unknown')
  const [error, setError] = useState('')
  // A grant we PROVED by opening the device. Outranks the Permissions API.
  const provenRef = useRef(false)

  const applyQueried = useCallback((queried: MicPermission | null) => {
    // `null` = the browser has no answer for us (Safari rejects the query for
    // some names). Treat that as "we must ask", never as a denial.
    if (queried === null) {
      setState(prev => (prev === 'unknown' ? 'prompt' : prev))
      return
    }
    if (provenRef.current && queried !== 'denied') return
    if (queried === 'denied') provenRef.current = false
    setState(queried)
  }, [])

  useEffect(() => {
    let live = true
    let status: PermissionStatus | null = null

    const recheck = () => {
      queryMicPermission().then(queried => {
        if (live) applyQueried(queried)
      })
    }

    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(s => {
        if (!live) return
        status = s
        applyQueried(s.state as MicPermission)
        // The OS can revoke while we sit here; mirror that immediately.
        s.onchange = () => applyQueried(s.state as MicPermission)
      })
      .catch(() => {
        if (live) applyQueried(null)
      })

    // Returning to the app is the other moment a grant can have changed.
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', recheck)

    return () => {
      live = false
      if (status) status.onchange = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', recheck)
    }
  }, [applyQueried])

  const unlock = useCallback(async () => {
    try {
      // Probe the SELECTED mic, not the OS default, so this transient grant
      // touches the same device recording will (see micConstraints).
      const stream = await openPreferredMicStream()
      for (const track of stream.getTracks()) track.stop()
      provenRef.current = true
      setState('granted')
      setError('')
      return true
    } catch (err) {
      console.warn('[voice] mic unlock refused:', err)
      provenRef.current = false
      setState('denied')
      setError(describeMicError(err))
      return false
    }
  }, [])

  const clearError = useCallback(() => setError(''), [])

  return { state, needsUnlock: state !== 'granted', unlock, error, clearError }
}

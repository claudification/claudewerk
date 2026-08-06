/**
 * Opt into the FULL commit tier for as long as a surface that renders commit
 * rows is mounted.
 *
 * Default for every socket is `counts` -- an id and an integer per commit. Only
 * a mounted Commits tab / browser needs whole rows, and a phone watching fifteen
 * conversations should not pay for the message, branch and file list of every
 * commit in the fleet. Mounting is the signal; unmount drops back to counts.
 *
 * Reference-counted: two commit surfaces open at once must not have the first
 * one to unmount downgrade the socket under the second.
 */

import { useEffect } from 'react'
import { wsSend } from '@/hooks/use-conversations'

let mounted = 0

function setMode(mode: 'counts' | 'full'): void {
  wsSend('commit_subscribe', { mode })
}

export function useFullCommitStream(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    mounted++
    if (mounted === 1) setMode('full')
    return () => {
      mounted--
      if (mounted === 0) setMode('counts')
    }
  }, [enabled])
}

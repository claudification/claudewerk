/**
 * Live view over the debug-log ring buffer: the filtered entries, the unfiltered
 * total, and stick-to-bottom scroll following.
 *
 * Two subscriptions, not one -- new log lines AND filter toggles both change
 * what should be on screen, but only the former should yank the scroll position
 * to the bottom. Toggling a level while reading history must not scroll away
 * from what you were reading.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { clearLog, getLogEntries, getVisibleLogEntries, subscribeLog } from '@/lib/debug-log'
import { subscribeLogFilter } from '@/lib/debug-log-filter'

/** Distance from the bottom (px) still counted as "following". */
const FOLLOW_SLACK_PX = 30

export function useDebugLogView() {
  const [entries, setEntries] = useState(getVisibleLogEntries)
  const [total, setTotal] = useState(() => getLogEntries().length)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  const refresh = useCallback((follow: boolean) => {
    setEntries([...getVisibleLogEntries()])
    setTotal(getLogEntries().length)
    if (!follow || !followRef.current) return
    requestAnimationFrame(() => {
      const el = scrollRef.current
      // Optional call: `scrollTo` is absent in jsdom, and a missing scroll is
      // never worth throwing out of a passive effect.
      el?.scrollTo?.({ top: el.scrollHeight })
    })
  }, [])

  useEffect(() => subscribeLog(() => refresh(true)), [refresh])
  useEffect(() => subscribeLogFilter(() => refresh(false)), [refresh])

  // Open at the bottom -- the newest lines are the reason the console opened.
  useEffect(() => {
    const el = scrollRef.current
    el?.scrollTo?.({ top: el.scrollHeight })
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
  }, [])

  const clear = useCallback(() => {
    clearLog()
    setEntries([])
    setTotal(0)
  }, [])

  return { entries, total, scrollRef, onScroll, clear }
}

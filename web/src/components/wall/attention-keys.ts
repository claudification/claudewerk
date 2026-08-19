/**
 * 1-5 answer the first five entries.
 *
 * The wall is a surface you WATCH, so the keys are global while A1 is mounted
 * rather than bound to a focused row -- you should never have to click a list
 * before you can answer it.
 *
 * TWO THINGS IT MUST NOT DO. It must not fire while the header's filter box has
 * focus (typing `~30m` would answer three permissions on the way), and it must
 * not shadow a browser or app chord -- so any modifier means the key is not
 * ours. An entry with no primary action (a soft `needs_you`, a dialog that needs
 * its full form) consumes nothing: the key is a no-op there, never a fallthrough
 * to the next entry, because "1 answered something further down the list" is how
 * you approve the wrong thing.
 */

import { useEffect, useRef } from 'react'
import { ATTENTION_KEYS, type AttentionEntry } from './attention-entries'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

/** Which entry a digit answers, or null when the digit is not ours. */
function entryForKey(entries: readonly AttentionEntry[], key: string): AttentionEntry | null {
  if (!/^[1-9]$/.test(key)) return null
  const index = Number(key)
  if (index > ATTENTION_KEYS) return null
  return entries[index - 1] ?? null
}

export function useAttentionKeys(entries: readonly AttentionEntry[]): void {
  // The listener is installed ONCE and reads the latest queue through a ref:
  // re-binding it every second (the waiting clock ticks the queue) would drop a
  // keystroke that landed between the removal and the add.
  const latest = useRef(entries)
  latest.current = entries

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      const primary = entryForKey(latest.current, e.key)?.actions[0]
      if (!primary) return
      e.preventDefault()
      primary.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

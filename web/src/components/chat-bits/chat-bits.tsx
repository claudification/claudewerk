/**
 * The two pieces every tiny chat surface in here needs.
 *
 * The voice orb's transcript and the canvas chat are different features that
 * arrived at the identical idiom twice: pin the scroll to the newest line, and
 * a textarea where Enter sends and Shift+Enter is a newline. Rather than let the
 * second copy settle in, both live here.
 *
 * Deliberately NOT a "Chat" component -- the two surfaces differ in everything
 * that matters visually (width, chrome, what a line looks like). These are the
 * two behaviours, not a layout.
 */

import { type RefObject, useEffect, useRef, useState } from 'react'

/**
 * Keep a scroll container pinned to its newest line.
 *
 * Depends on the LENGTH and the tail text, not the array identity: a streaming
 * agent turn rewrites the last entry in place, which must still scroll, while a
 * new array with identical content must not re-run.
 */
export function usePinToBottom(lines: { text: string }[]): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const tail = lines.at(-1)?.text ?? ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: length + tail ARE the change signal
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, tail])
  return ref
}

/**
 * A chat input: Enter sends, Shift+Enter is a newline, a multi-line paste stays
 * one message either way. Owns its own draft so the parent re-renders only when
 * something is actually sent.
 */
export function ChatComposer({
  onSend,
  placeholder,
  disabled,
  autoFocus,
  rows = 2,
}: {
  onSend: (text: string) => void
  placeholder: string
  disabled?: boolean
  autoFocus?: boolean
  rows?: number
}) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only focus
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [])

  function send() {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
  }

  return (
    <textarea
      ref={ref}
      rows={rows}
      value={draft}
      disabled={disabled}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          send()
        }
      }}
      placeholder={placeholder}
      className="w-full resize-none rounded border border-border bg-background px-2 py-1 font-mono text-[11px] placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary"
    />
  )
}

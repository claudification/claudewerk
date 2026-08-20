/**
 * `useWallCopy()` -- THE COPY CONTRACT SYMBOL, and the ONE clipboard write on
 * this surface.
 *
 * Two callers, one behaviour: a pane header copying its report, and a row
 * copying its own value. They differ only in what they hand over.
 *
 * A FAILED COPY IS REPORTED, NEVER SWALLOWED, and that is the whole reason this
 * hook exists rather than a third `navigator.clipboard.writeText().catch(() =>
 * {})`. Both implementations this card replaced ate the rejection: the river's
 * button `.catch(() => {})`, S1's `() => setCopied(false)`. A silent no-op copy
 * is worse than an error -- you walk away believing you have the sha, and paste
 * whatever was on the clipboard before.
 *
 * THE FAILURE IS REPORTED TWICE, ON PURPOSE.
 *
 *  1. A toast, which is the fleet's one notification channel.
 *  2. The BUTTON's own state, which is the half that matters when the wall is
 *     DETACHED. `ToastContainer` is mounted once, in the main window's app tree
 *     (`app.tsx`), and a detached wall is a separate window -- so a toast raised
 *     from a click inside the popup renders behind it, where nobody is looking.
 *     The button says so where the click happened.
 *
 * There is no `navigator.clipboard` at all on an insecure origin or in an old
 * WebView. That is a REFUSAL, not an absence, and it takes the same path.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '@/lib/toast-bus'

/** How long the button holds its confirmation before going back to rest. */
const SETTLE_MS = 1200
/** A refusal holds longer -- it is a thing to read, not a thing to notice. */
const FAILED_MS = 4000

export type WallCopyState = 'rest' | 'copied' | 'failed'

export interface WallCopy {
  /** `rest` until a click, then `copied` or `failed` for a beat. */
  state: WallCopyState
  /** Why the last copy failed, for the button's own label. `null` at rest. */
  error: string | null
  /**
   * Put `text` on the clipboard and say what happened. `label` is what the toast
   * names -- "the sha a1b2c3d", "PULSE" -- so a confirmation says WHICH copy
   * landed when you have hit three buttons in five seconds.
   */
  copy: (text: string, label: string) => void
}

function refusalMessage(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason ?? '')
  return detail ? `clipboard refused: ${detail}` : 'clipboard refused'
}

export function useWallCopy(): WallCopy {
  const [state, setState] = useState<WallCopyState>('rest')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const settle = useCallback((next: WallCopyState, ms: number) => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('rest'), ms)
  }, [])

  const copy = useCallback(
    (text: string, label: string) => {
      const clipboard = navigator.clipboard
      if (!clipboard) {
        // Not a missing feature to shrug at: the user asked for a copy and did
        // not get one, and the reason is actionable (open the panel over https).
        setError('no clipboard on this origin')
        showToast({
          title: 'Copy failed',
          body: 'No clipboard on this origin -- the panel must be served over https.',
          variant: 'error',
        })
        settle('failed', FAILED_MS)
        return
      }
      clipboard.writeText(text).then(
        () => {
          setError(null)
          showToast({
            title: `Copied ${label}`,
            body: `${text.length} characters on the clipboard.`,
            variant: 'success',
          })
          settle('copied', SETTLE_MS)
        },
        reason => {
          const message = refusalMessage(reason)
          setError(message)
          showToast({ title: 'Copy failed', body: `${label} was not copied -- ${message}.`, variant: 'error' })
          settle('failed', FAILED_MS)
        },
      )
    },
    [settle],
  )

  return { state, error, copy }
}

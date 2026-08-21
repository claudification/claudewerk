/**
 * The filter box's autocomplete, as one hook: which sigil is live, what it can
 * offer, which row is selected, and what each key does.
 *
 * Split out of `wall-filter-box.tsx` so the box stays the small controlled input
 * it was designed to be. The box owns the store binding and the two document
 * hotkeys; this owns the dropdown.
 *
 * THE CARET IS STATE HERE, not read off the DOM at render. A controlled input
 * re-renders from the store, and `selectionStart` read during that render is the
 * caret BEFORE the change on some paths -- so the position is captured in the
 * same handler that captured the text and the two can never disagree.
 *
 * DISMISSED IS PER-TOKEN. Escape closes the list without leaving the box (the
 * card's rule: the box's own Escape-to-blur must still be reachable with a
 * second press), and typing anything else re-opens it -- otherwise one Escape
 * would silently kill autocomplete for the rest of the session.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { useWallFilterValues } from './use-wall-filter-values'
import { activeSuggestToken, applySuggestion, rankSuggestions, type SuggestSigil } from './wall-filter-suggest'

export interface WallFilterSuggest {
  /** The live sigil, or null when the caret is not inside a completable token. */
  sigil: SuggestSigil | null
  /** What to show. Empty means: render nothing. */
  values: readonly string[]
  /** Index into `values`. Always in range while `values` is non-empty. */
  selected: number
  setSelected: (index: number) => void
  /** Remember where the caret is after any event that can move it. */
  onCaret: (caret: number) => void
  /** Accept a value: rewrites the box and puts the caret after it. */
  accept: (value: string) => void
  /** Arrow / Tab / Enter. True when the key was ours and must not bubble. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => boolean
  /** Escape #1. True when there WAS a list to close, so the box knows whether
   *  to spend the key or blur instead. */
  dismiss: () => boolean
}

export function useWallFilterSuggest(
  raw: string,
  setRaw: (raw: string) => void,
  inputRef: React.RefObject<HTMLInputElement | null>,
): WallFilterSuggest {
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  /** The exact box text Escape was pressed against. Any edit revives the list. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  const token = useMemo(() => activeSuggestToken(raw, caret), [raw, caret])
  const open = token !== null && dismissedAt !== raw
  const values = useWallFilterValues(open ? token.sigil : null)
  const ranked = useMemo(
    () => (open && token ? rankSuggestions(token.needle, values) : []),
    [open, token, values],
  )

  // Clamped rather than reset-on-change: a stale index from a longer list would
  // otherwise accept a value the user cannot see.
  const index = ranked.length ? Math.min(selected, ranked.length - 1) : 0

  const onCaret = useCallback((next: number) => {
    setCaret(next)
    setSelected(0)
  }, [])

  const tokenRef = useRef(token)
  tokenRef.current = token

  const accept = useCallback(
    (value: string) => {
      const live = tokenRef.current
      if (!live) return
      const next = applySuggestion(raw, live, value)
      setRaw(next.raw)
      setCaret(next.caret)
      setSelected(0)
      setDismissedAt(null)
      // The store write re-renders the input from `raw`, which would otherwise
      // put the caret at the end of the whole string. Restored after paint so it
      // lands on the value that was just inserted, not past the rest of the box.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) el.setSelectionRange(next.caret, next.caret)
      })
    },
    [raw, setRaw, inputRef],
  )

  const dismiss = useCallback(() => {
    if (!ranked.length) return false
    setDismissedAt(raw)
    return true
  }, [ranked.length, raw])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (!ranked.length) return false
      if (event.key === 'ArrowDown') {
        setSelected(i => (Math.min(i, ranked.length - 1) + 1) % ranked.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setSelected(i => (Math.min(i, ranked.length - 1) + ranked.length - 1) % ranked.length)
        return true
      }
      // Tab and Enter both accept. Tab because that is what a shell completes
      // with; Enter because the box has no submit to steal it from.
      if (event.key === 'Tab' || event.key === 'Enter') {
        accept(ranked[index])
        return true
      }
      return false
    },
    [ranked, index, accept],
  )

  return {
    sigil: ranked.length && token ? token.sigil : null,
    values: ranked,
    selected: index,
    setSelected,
    onCaret,
    accept,
    onKeyDown,
    dismiss,
  }
}

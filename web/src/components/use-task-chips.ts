/**
 * The accepted-token chip set, and the rules for changing it.
 *
 * Its own hook because chips have a lifecycle that has nothing to do with the
 * modal's: they are seeded from epic focus on open, edited by the completer,
 * partially invalidated by a board switch, and cleared on close. Folding that
 * into `useQuickTask` is what pushed it over the complexity bar.
 */

import { useCallback, useState } from 'react'
import { applyChip, emptyChips, removeChip, type TaskChips } from '@/lib/cards/task-chips'
import type { TokenKind } from '@/lib/cards/task-tokens'
import { haptic } from '@/lib/utils'

export function useTaskChips() {
  const [chips, setChips] = useState<TaskChips>(emptyChips)

  /** Seed from the epic on screen, or clear. Called on every open. */
  const seed = useCallback((epic: string | null) => {
    setChips(epic ? { ...emptyChips(), epic } : emptyChips())
  }, [])

  const add = useCallback((kind: TokenKind, value: string) => {
    haptic('tap')
    setChips(prev => applyChip(prev, kind, value))
  }, [])

  const drop = useCallback((kind: TokenKind, value?: string) => {
    setChips(prev => removeChip(prev, kind, value))
  }, [])

  /**
   * A board switch invalidates every card-shaped chip: an epic id and a card id
   * are only meaningful on the board they came from, so carrying them across
   * would write a dangling `epic:` the target has never heard of. Priority and
   * the model hint are board-independent and survive -- a model slug names an
   * Anthropic model, not a row on this board.
   */
  const keepOnlyPortable = useCallback(() => {
    setChips(prev => ({ ...emptyChips(), priority: prev.priority, model: prev.model }))
  }, [])

  const clear = useCallback(() => setChips(emptyChips()), [])

  return { chips, seed, add, drop, keepOnlyPortable, clear }
}

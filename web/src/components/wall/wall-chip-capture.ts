/**
 * THE PROJECT CHIP, intercepted on the way DOWN.
 *
 * A wall row is already a click target -- P1's rows are `<button>`s, P2's are
 * clickable `<div>`s -- so the chip inside one cannot be its own button. The
 * click is caught in the CAPTURE phase instead, which is also what stops the row
 * selecting itself when the user only meant to scope the wall.
 *
 * It calls the store's exported action: there is exactly one implementation of
 * "scope to this project, or clear it if it already is the scope", and it is in
 * the filter store, not here.
 *
 * Extracted at the P2 merge (R19) -- P1 and P2 had grown the identical handler
 * on branches that were open at the same time, so neither werk-worker could have
 * seen the other's copy.
 */

import type React from 'react'
import { useWallFilterStore } from '@/lib/wall/filter-store'

export function handleChipCapture(event: React.MouseEvent<HTMLElement>): void {
  const chip = (event.target as HTMLElement).closest('[data-project]')
  const project = chip?.getAttribute('data-project')
  if (!project) return
  event.stopPropagation()
  useWallFilterStore.getState().toggleProject(project)
}

/**
 * Which host shell (if any) is expanded into the ShellOverlay, plus the two
 * roster-reconciliation effects: drop the selection when that shell leaves the
 * roster, and auto-expand a shell THIS client just opened once it lands. Split
 * out of <Dock> so the tray component stays simple.
 */
import type { ShellRosterEntry } from '@shared/protocol'
import { useState } from 'react'
import { useShellAutoExpandId, useShellsStore } from './use-shells'

type ShellRoster = Record<string, ShellRosterEntry>

// fallow-ignore-next-line complexity
export function useShellExpansion(roster: ShellRoster): [string | null, (id: string | null) => void] {
  const autoExpandId = useShellAutoExpandId()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Render-time adjustments: track roster + autoExpandId changes
  const [prevRoster, setPrevRoster] = useState(roster)
  const [prevAutoExpandId, setPrevAutoExpandId] = useState(autoExpandId)
  const rosterChanged = roster !== prevRoster
  const autoExpandChanged = autoExpandId !== prevAutoExpandId

  if (rosterChanged || autoExpandChanged) {
    if (rosterChanged) setPrevRoster(roster)
    if (autoExpandChanged) setPrevAutoExpandId(autoExpandId)

    // Drop the expanded selection if that shell left the roster (killed/exited).
    if (rosterChanged && expandedId && !roster[expandedId]) {
      setExpandedId(null)
    }

    // Auto-maximize a shell THIS client just opened, once it lands in the roster
    // (the `shell_added` round-trip arrives a tick after open-shell). Clear the
    // pending id so it fires exactly once and never re-expands after a minimize.
    if (autoExpandId && roster[autoExpandId]) {
      setExpandedId(autoExpandId)
      useShellsStore.getState().setAutoExpandId(null)
    }
  }

  return [expandedId, setExpandedId]
}

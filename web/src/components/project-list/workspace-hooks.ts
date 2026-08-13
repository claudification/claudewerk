// The workspace KEYBOARD layer + the stale-active-pointer guard. Mutations live
// in workspace-actions.ts, colours in workspace-colors.ts.

import { useEffect, useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import type { Workspace } from '@/lib/types'
import { switchWorkspace } from '@/lib/workspace-switch'

/** The positional default for a workspace at index `i` (0-based). Slot 1 is
 *  reserved for the All view, so the first workspace is Ctrl+2. Beyond the
 *  ninth workspace there is no default -- assign a custom key instead. */
export function positionalWorkspaceKey(index: number): string | null {
  return index + 2 <= 9 ? `ctrl+${index + 2}` : null
}

// Ctrl+1 = All, Ctrl+2 = first workspace, Ctrl+3 = second, ... Fires the same
// explicit switch as a tab click -- selection never drives the mode, only this does.
function switchToWorkspaceSlot(digit: number) {
  if (digit === 1) return switchWorkspace(null)
  const ws = useConversationsStore.getState().projectOrder.workspaces ?? []
  const target = ws[digit - 2]?.id
  if (target) switchWorkspace(target)
}

/**
 * The positional Ctrl+N defaults, then every custom key laid OVER them.
 *
 * Custom wins on collision by construction (it is assigned second), which is
 * what makes reordering safe: dragging a workspace renumbers the positional
 * slots, and a workspace that owns an explicit key keeps it regardless.
 */
export function buildWorkspaceBindings(workspaces: Workspace[]): Record<string, (e: KeyboardEvent) => void> {
  const bindings: Record<string, (e: KeyboardEvent) => void> = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`ctrl+${i + 1}`, () => switchToWorkspaceSlot(i + 1)]),
  )
  for (const ws of workspaces) {
    if (ws.key) bindings[ws.key] = () => switchWorkspace(ws.id)
  }
  return bindings
}

// A persisted activeWorkspaceId is dangling when the workspace list is known
// (non-empty) yet does not contain it -- e.g. the workspace was deleted on
// another device. `false` while the list is still empty so a not-yet-loaded
// order never trips a reset.
function isStaleActiveWorkspace(activeWorkspaceId: string | null, workspaces: Workspace[] | undefined): boolean {
  if (!activeWorkspaceId || !workspaces || workspaces.length === 0) return false
  return !workspaces.some(w => w.id === activeWorkspaceId)
}

// Registered as a BASE layer at CAPTURE phase (via the key-layer system) with
// captureTerminal so a focused xterm, an open command palette, or a chord in
// flight can no longer swallow the keys the way the old raw bubble-phase
// window listener did -- that starvation was the "sometimes it works" flake.
export function useWorkspaceShortcuts() {
  const workspaces = useConversationsStore(s => s.projectOrder.workspaces)
  const bindings = useMemo(() => buildWorkspaceBindings(workspaces ?? []), [workspaces])

  useKeyLayer(bindings, { base: true, id: 'workspace-shortcuts', captureTerminal: true })

  // Once the workspace list is known, drop a dangling active pointer back to All.
  const activeWorkspaceId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  useEffect(() => {
    if (isStaleActiveWorkspace(activeWorkspaceId, workspaces)) {
      useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId: null })
    }
  }, [activeWorkspaceId, workspaces])
}

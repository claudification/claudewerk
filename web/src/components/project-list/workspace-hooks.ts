import { useCallback, useEffect } from 'react'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import type { ProjectOrder, ProjectOrderNode, Workspace } from '@/lib/types'
import {
  loadValidWorkspaceConversation,
  saveLastWorkspaceConversation,
  WORKSPACE_ALL,
} from '@/lib/workspace-membership'

export const WORKSPACE_COLORS = ['emerald', 'blue', 'purple', 'amber', 'rose', 'cyan', 'orange', 'pink'] as const

export const colorClasses: Record<string, { bg: string; ring: string }> = {
  emerald: { bg: 'bg-emerald-500/20', ring: 'ring-emerald-500/50' },
  blue: { bg: 'bg-blue-500/20', ring: 'ring-blue-500/50' },
  purple: { bg: 'bg-purple-500/20', ring: 'ring-purple-500/50' },
  amber: { bg: 'bg-amber-500/20', ring: 'ring-amber-500/50' },
  rose: { bg: 'bg-rose-500/20', ring: 'ring-rose-500/50' },
  cyan: { bg: 'bg-cyan-500/20', ring: 'ring-cyan-500/50' },
  orange: { bg: 'bg-orange-500/20', ring: 'ring-orange-500/50' },
  pink: { bg: 'bg-pink-500/20', ring: 'ring-pink-500/50' },
}

const colorDotMap: Record<string, string> = {
  emerald: 'bg-emerald-400', blue: 'bg-blue-400', purple: 'bg-purple-400',
  amber: 'bg-amber-400', rose: 'bg-rose-400', cyan: 'bg-cyan-400',
  orange: 'bg-orange-400', pink: 'bg-pink-400',
}

export function colorDot(color?: string): string {
  return colorDotMap[color ?? ''] ?? 'bg-muted-foreground/40'
}

function mutateOrder(fn: (order: ProjectOrder) => ProjectOrder) {
  const cur = useConversationsStore.getState().projectOrder as ProjectOrder
  const next = fn(cur)
  useConversationsStore.getState().setProjectOrder(next)
  saveProjectOrder(next)
}

function setTrees(o: ProjectOrder, trees: Record<string, ProjectOrderNode[]>): ProjectOrder {
  return { ...o, workspaceTrees: Object.keys(trees).length > 0 ? trees : undefined }
}

// Switching a workspace is the ONE and ONLY thing that changes the active
// workspace. Its entire side effect: remember the conversation we're leaving
// behind for the OLD workspace, flip the mode, then restore the NEW workspace's
// last conversation IF it still exists (a dead id is pruned and we drop to the
// workspace summary with nothing selected). It NEVER bounces you into a
// different workspace than the one you picked -- there is no reverse lookup.
// fallow-ignore-next-line complexity
function switchWorkspace(id: string | null) {
  const store = useConversationsStore.getState()
  const prevWs = store.controlPanelPrefs.activeWorkspaceId ?? WORKSPACE_ALL
  const curConv = store.selectedConversationId
  if (curConv) saveLastWorkspaceConversation(prevWs, curConv)

  const targetWs = id ?? WORKSPACE_ALL
  store.updateControlPanelPrefs({ activeWorkspaceId: id })

  const restored = loadValidWorkspaceConversation(
    targetWs,
    cid => !!useConversationsStore.getState().conversationsById[cid],
  )
  if (restored === curConv) return
  useConversationsStore.getState().selectConversation(restored ?? null, 'workspace-switch')
}

export function useWorkspaceActions() {
  const setActive = useCallback(switchWorkspace, [])

  return {
    setActive,
    create(name: string, existingCount: number) {
      const id = `ws-${Date.now().toString(36)}`
      const color = WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length]
      mutateOrder(o => ({ ...o, workspaces: [...(o.workspaces ?? []), { id, name, color }] }))
      setActive(id)
    },
    rename(wsId: string, name: string) {
      mutateOrder(o => ({
        ...o,
        workspaces: (o.workspaces ?? []).map(w => (w.id === wsId ? { ...w, name } : w)),
      }))
    },
    remove(wsId: string, activeId: string | null) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        delete trees[wsId]
        return { ...setTrees(o, trees), workspaces: (o.workspaces ?? []).filter(w => w.id !== wsId) }
      })
      // Drop the gone workspace's remembered conversation so it cannot linger.
      saveLastWorkspaceConversation(wsId, null)
      if (activeId === wsId) setActive(null)
    },
    recolor(wsId: string, color: string) {
      mutateOrder(o => ({
        ...o,
        workspaces: (o.workspaces ?? []).map(w => (w.id === wsId ? { ...w, color } : w)),
      }))
    },
    assignProject(projectUri: string, wsId: string) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        const wsTree = [...(trees[wsId] ?? [])]
        if (!wsTree.some(n => n.id === projectUri)) {
          wsTree.push({ id: projectUri, type: 'project' })
        }
        trees[wsId] = wsTree
        return setTrees(o, trees)
      })
    },
    removeFromWorkspace(nodeId: string, wsId: string) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        const wsTree = trees[wsId]
        if (!wsTree) return o
        trees[wsId] = wsTree.filter(n => n.id !== nodeId)
        if (trees[wsId].length === 0) delete trees[wsId]
        return setTrees(o, trees)
      })
    },
    removeFromAllWorkspaces(projectUri: string) {
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        for (const [wid, wTree] of Object.entries(trees)) {
          trees[wid] = wTree.filter(n => n.id !== projectUri)
          if (trees[wid].length === 0) delete trees[wid]
        }
        return setTrees(o, trees)
      })
    },
    createAndAssign(name: string, existingCount: number, projectUri: string) {
      const wsId = `ws-${Date.now().toString(36)}`
      const color = WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length]
      mutateOrder(o => {
        const trees = { ...(o.workspaceTrees ?? {}) }
        trees[wsId] = [{ id: projectUri, type: 'project' }]
        return { ...o, workspaces: [...(o.workspaces ?? []), { id: wsId, name, color }], workspaceTrees: trees }
      })
      setActive(wsId)
    },
  }
}

// Ctrl+1 = All, Ctrl+2 = first workspace, Ctrl+3 = second, ... (slot 1 is
// reserved for the All view by design). Fires the same explicit switch as a tab
// click -- selection never drives the mode, only this does.
// fallow-ignore-next-line complexity
function switchToWorkspaceSlot(digit: number) {
  if (digit === 1) return switchWorkspace(null)
  const ws = useConversationsStore.getState().projectOrder.workspaces ?? []
  const target = ws[digit - 2]?.id
  if (target) switchWorkspace(target)
}

// Registered as a BASE layer at CAPTURE phase (via the key-layer system) with
// captureTerminal so a focused xterm, an open command palette, or a chord in
// flight can no longer swallow the keys the way the old raw bubble-phase
// window listener did -- that starvation was the "sometimes it works" flake.
const WORKSPACE_KEY_BINDINGS: Record<string, (e: KeyboardEvent) => void> = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`ctrl+${i + 1}`, () => switchToWorkspaceSlot(i + 1)]),
)

// A persisted activeWorkspaceId is dangling when the workspace list is known
// (non-empty) yet does not contain it -- e.g. the workspace was deleted on
// another device. `false` while the list is still empty so a not-yet-loaded
// order never trips a reset.
function isStaleActiveWorkspace(activeWorkspaceId: string | null, workspaces: Workspace[] | undefined): boolean {
  if (!activeWorkspaceId || !workspaces || workspaces.length === 0) return false
  return !workspaces.some(w => w.id === activeWorkspaceId)
}

export function useWorkspaceShortcuts() {
  useKeyLayer(WORKSPACE_KEY_BINDINGS, { base: true, id: 'workspace-shortcuts', captureTerminal: true })

  // Once the workspace list is known, drop a dangling active pointer back to All.
  const activeWorkspaceId = useConversationsStore(s => s.controlPanelPrefs.activeWorkspaceId)
  const workspaces = useConversationsStore(s => s.projectOrder.workspaces)
  useEffect(() => {
    if (isStaleActiveWorkspace(activeWorkspaceId, workspaces)) {
      useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId: null })
    }
  }, [activeWorkspaceId, workspaces])
}

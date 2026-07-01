import { useCallback, useEffect } from 'react'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, ProjectOrderNode, Workspace } from '@/lib/types'

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

const WS_LAST_CONV_KEY = 'workspace-last-conversation'

function loadLastConversations(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(WS_LAST_CONV_KEY) ?? '{}') } catch { return {} }
}

function saveLastConversation(wsId: string, convId: string | null) {
  const map = loadLastConversations()
  if (convId) map[wsId] = convId
  else delete map[wsId]
  localStorage.setItem(WS_LAST_CONV_KEY, JSON.stringify(map))
}

export function useWorkspaceActions() {
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  // fallow-ignore-next-line complexity
  const setActive = useCallback((id: string | null) => {
    const store = useConversationsStore.getState()
    const prevWs = store.controlPanelPrefs.activeWorkspaceId ?? '_all'
    const curConv = store.selectedConversationId
    if (curConv) saveLastConversation(prevWs, curConv)
    const targetWs = id ?? '_all'
    const lastConv = loadLastConversations()[targetWs]
    updatePrefs({ activeWorkspaceId: id })
    if (lastConv && lastConv !== curConv) {
      requestAnimationFrame(() => {
        useConversationsStore.getState().selectConversation(lastConv, 'workspace-switch')
      })
    }
  }, [updatePrefs])

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

export function useWorkspaceShortcuts() {
  useEffect(() => {
    // fallow-ignore-next-line complexity
    function handler(e: KeyboardEvent) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const digit = Number(e.key)
      if (digit < 1 || digit > 9 || Number.isNaN(digit)) return
      e.preventDefault()
      const s = useConversationsStore.getState()
      const ws = s.projectOrder.workspaces ?? []
      const target = digit === 1 ? null : (ws[digit - 2]?.id ?? null)
      if (digit > 1 && !ws[digit - 2]) return
      s.updateControlPanelPrefs({ activeWorkspaceId: target })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}

import { useCallback, useEffect } from 'react'
import { saveProjectOrder, useConversationsStore } from '@/hooks/use-conversations'
import type { ProjectOrder, Workspace } from '@/lib/types'

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
  emerald: 'bg-emerald-400',
  blue: 'bg-blue-400',
  purple: 'bg-purple-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  cyan: 'bg-cyan-400',
  orange: 'bg-orange-400',
  pink: 'bg-pink-400',
}

export function colorDot(color?: string): string {
  return colorDotMap[color ?? ''] ?? 'bg-muted-foreground/40'
}

function mutateWorkspaces(
  fn: (
    ws: Workspace[],
    assignments: Record<string, string>,
  ) => {
    workspaces: Workspace[]
    assignments: Record<string, string>
  },
) {
  const cur = useConversationsStore.getState().projectOrder as ProjectOrder
  const result = fn(cur.workspaces ?? [], cur.assignments ?? {})
  const next: ProjectOrder = { ...cur, ...result }
  useConversationsStore.getState().setProjectOrder(next)
  saveProjectOrder(next)
}

export function useWorkspaceActions() {
  const updatePrefs = useConversationsStore(s => s.updateControlPanelPrefs)
  const setActive = useCallback((id: string | null) => updatePrefs({ activeWorkspaceId: id }), [updatePrefs])

  return {
    setActive,
    create(name: string, existingCount: number) {
      const id = `ws-${Date.now().toString(36)}`
      const color = WORKSPACE_COLORS[existingCount % WORKSPACE_COLORS.length]
      mutateWorkspaces((ws, a) => ({ workspaces: [...ws, { id, name, color }], assignments: a }))
      setActive(id)
    },
    rename(wsId: string, name: string) {
      mutateWorkspaces((ws, a) => ({
        workspaces: ws.map(w => (w.id === wsId ? { ...w, name } : w)),
        assignments: a,
      }))
    },
    remove(wsId: string, activeId: string | null) {
      mutateWorkspaces((ws, a) => {
        const filtered: Record<string, string> = {}
        for (const [k, v] of Object.entries(a)) if (v !== wsId) filtered[k] = v
        return { workspaces: ws.filter(w => w.id !== wsId), assignments: filtered }
      })
      if (activeId === wsId) setActive(null)
    },
    recolor(wsId: string, color: string) {
      mutateWorkspaces((ws, a) => ({
        workspaces: ws.map(w => (w.id === wsId ? { ...w, color } : w)),
        assignments: a,
      }))
    },
    assign(nodeId: string, wsId: string | null) {
      mutateWorkspaces((ws, a) => {
        const next = { ...a }
        if (wsId) next[nodeId] = wsId
        else delete next[nodeId]
        return { workspaces: ws, assignments: next }
      })
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

// The workspace palette. Split out of workspace-hooks so the tab strip, the
// context menus and the Manage Workspaces modal can all take the colours
// without dragging the mutation actions (and the store) along with them.

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

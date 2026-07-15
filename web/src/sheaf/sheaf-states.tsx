/** Sheaf non-data states: error banner, empty fleet, loading skeleton. */

import { Button } from '@/components/ui/button'

export function ErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="border border-rose-500/30 bg-rose-500/10 rounded p-3 text-xs">
      <div className="font-semibold text-rose-300 mb-1">Sheaf failed to load</div>
      <div className="font-mono text-rose-200/80 break-all">{error}</div>
      <Button variant="ghost" size="sm" onClick={onRetry} className="mt-2">
        Retry
      </Button>
    </div>
  )
}

export function EmptyState({ windowH }: { windowH: number }) {
  return (
    <div className="text-center py-16 text-muted-foreground">
      <div className="text-2xl mb-2">🌾</div>
      <div className="text-sm">No fleet activity in the last {windowH}h.</div>
      <div className="text-xs mt-1 opacity-70">All projects quiet.</div>
    </div>
  )
}

export function Skeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="border border-border/40 rounded p-3 animate-pulse">
          <div className="h-4 w-1/3 bg-muted/40 rounded mb-2" />
          <div className="h-3 w-2/3 bg-muted/30 rounded mb-1" />
          <div className="h-3 w-1/2 bg-muted/30 rounded" />
        </div>
      ))}
    </div>
  )
}

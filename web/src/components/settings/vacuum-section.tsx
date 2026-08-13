/**
 * Settings entry point for VACUUM, sitting beside its read-only sibling
 * (Transcript Coverage). Coverage answers "what is where"; this opens the
 * surface that acts on it.
 *
 * Only a launcher: the panel itself is a lazy chunk mounted at the app shell,
 * so opening Settings never pays for it.
 */

import { Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { openVacuum } from '../vacuum/vacuum-state'

export function VacuumSection() {
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Archive aged transcript months to cold storage and reclaim the pages they occupy, with a measured estimate for
        every category before anything is touched. Admin only, and nothing is deleted until a verified backup exists and
        each month's cold archive has been checked against the live database.
      </div>
      <Button variant="outline" size="sm" onClick={openVacuum}>
        <Trash2 className="size-3" />
        Open Vacuum
      </Button>
    </div>
  )
}

export function vacuumMatches(filter: string): boolean {
  const f = filter.toLowerCase()
  return ['vacuum', 'cleanup', 'clean', 'disk', 'space', 'reclaim', 'prune', 'purge', 'storage'].some(
    k => k.includes(f) || f.includes(k),
  )
}

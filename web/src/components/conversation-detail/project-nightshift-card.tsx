/**
 * Project action-panel entry for nightshift -- shown ONLY when the project had a
 * run in the last 7 days (otherwise self-hides, keeping the panel clean). Opens
 * the Nightshift modal on the Report tab. Reuses the snapshot the modal also reads.
 */

import { Moon } from 'lucide-react'
import { useNightshift } from '@/hooks/use-nightshift'
import { openNightshiftModal } from '@/hooks/use-nightshift-modal'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function withinWeek(iso: string | undefined): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.now() - t <= WEEK_MS
}

export function ProjectNightshiftCard({ projectUri }: { projectUri: string }) {
  const { snapshot } = useNightshift(projectUri)
  const run = snapshot?.run
  if (!run || !(withinWeek(run.finished) || withinWeek(run.created))) return null

  const { ready, blocked } = run.totals
  return (
    <button
      type="button"
      onClick={() => openNightshiftModal(projectUri, 'report')}
      className="w-full flex items-center gap-3 px-3 py-2 border border-amber-500/30 hover:border-amber-400/60 hover:bg-amber-500/5 transition-colors text-left"
    >
      <Moon className="size-4 text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono text-amber-300">Nightshift report · {run.date}</div>
        <div className="text-[10px] text-muted-foreground">
          {ready} ready{blocked > 0 ? ` · ${blocked} need you` : ''}
        </div>
      </div>
      <span className="text-[10px] font-mono text-fg-dim shrink-0">VIEW</span>
    </button>
  )
}

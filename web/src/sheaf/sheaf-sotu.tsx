/**
 * SOTU enrichment renderers for the Sheaf fleet view (Phase 6).
 *
 * SOTU plugs its narrative + git-fabric INTO the existing Sheaf structure rather
 * than a parallel panel. This file owns the composition:
 *   - `SotuProjectStrip`: per-project narrative (markdown) + git escalation
 *     alerts + CONTENDED pill + per-branch merge-risk + citation grounding,
 *     shown under a project header.
 *   - `FleetSotuStats`: the cheap fleet union folded into the totals strip.
 * The individual chips live in sheaf-sotu-chips.tsx.
 */

import type { SheafFleetSotu, SheafProjectSotu } from '@shared/sheaf-types'
import { Markdown } from '@/components/markdown'
import { formatAgo } from './format'
import { AlertChip, BranchRisk, ContendedPill, GroundingChip } from './sheaf-sotu-chips'

/** Per-project SOTU strip rendered between a project's header and its forest. */
export function SotuProjectStrip({ sotu }: { sotu: SheafProjectSotu | undefined }) {
  if (!sotu) return null
  const hasAnything =
    sotu.narrative ||
    sotu.alerts.length > 0 ||
    sotu.contended > 0 ||
    sotu.grounding !== undefined ||
    sotu.branches.some(b => b.aheadOrigin > 0 || b.integration === 'conflicts')
  if (!hasAnything) return null
  return (
    <div className="mx-1 mb-1 rounded border border-border/50 bg-muted/20 px-3 py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {sotu.contended > 0 && <ContendedPill count={sotu.contended} />}
        {sotu.alerts.map(a => (
          <AlertChip key={a} alert={a} />
        ))}
        {sotu.grounding && <GroundingChip g={sotu.grounding} />}
        {!sotu.enabled && (
          <span
            className="text-[10px] text-muted-foreground/50 italic"
            title="SOTU paid distill not enabled -- free floor only"
          >
            floor only
          </span>
        )}
        {sotu.scannedAt !== undefined && (
          <span
            className="text-[10px] text-muted-foreground/50 font-mono"
            title="Age of the git-fabric scan behind these alerts. Opening the sheaf schedules a fresh scan; refresh again to pick it up."
          >
            scanned {formatAgo(Date.now() - sotu.scannedAt)}
          </span>
        )}
      </div>
      {sotu.narrative && (
        <div className="text-xs text-foreground/90 leading-snug [&_p]:mb-1 [&_p:last-child]:mb-0">
          <Markdown>{sotu.narrative}</Markdown>
        </div>
      )}
      <BranchRisk branches={sotu.branches} />
    </div>
  )
}

/** Fleet-union stats folded into the totals strip (cheap, zero-LLM). */
export function FleetSotuStats({ sotu }: { sotu: SheafFleetSotu | undefined }) {
  if (!sotu) return null
  const parts: React.ReactNode[] = []
  if (sotu.contended > 0) parts.push(<ContendedPill key="c" count={sotu.contended} />)
  for (const a of sotu.alerts) parts.push(<AlertChip key={a} alert={a} />)
  if (sotu.grounding) parts.push(<GroundingChip key="g" g={sotu.grounding} />)
  if (sotu.filteredProjects > 0) {
    parts.push(
      <span
        key="f"
        className="text-[10px] text-muted-foreground/60 italic"
        title="Projects hidden by per-project visibility"
      >
        {sotu.filteredProjects} hidden
      </span>,
    )
  }
  if (parts.length === 0) return null
  return <div className="flex flex-wrap items-center gap-1.5 ml-auto">{parts}</div>
}

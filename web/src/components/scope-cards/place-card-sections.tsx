import type { ProjectCommitStats } from '@/hooks/use-project-commit-stats'
import type { ProjectIntegration } from '@/hooks/use-project-integration'
import { formatAgeShort } from '@/lib/status-style'
import { ScopeSection, ScopeStat, ScopeStats } from './scope-stat'

/**
 * The two PLACE sections whose numbers come off the wire: the project's whole
 * commit history, and what the last git scan saw. Split out of place-card so
 * each stays a small pure renderer over a plain payload.
 */

export function PlaceCommits({ stats }: { stats: ProjectCommitStats | null }) {
  return (
    <ScopeSection label="commits">
      {stats ? (
        <>
          <div className="text-[10px] text-foreground/85 font-mono">
            {stats.total} total {'·'} {stats.today} today
            {stats.lastCommittedAt != null && (
              <span className="text-fg-dim">
                {' · '}last {formatAgeShort(stats.lastCommittedAt)} ago
              </span>
            )}
          </div>
          <ScopeStats>
            <ScopeStat label="agent" value={stats.agent} tone="text-sky-400/90" />
            <ScopeStat label="human" value={stats.human} tone="text-fg-muted" />
          </ScopeStats>
        </>
      ) : (
        <div className="text-[10px] text-fg-faint">loading…</div>
      )}
    </ScopeSection>
  )
}

export function PlaceIntegration({ integration }: { integration: ProjectIntegration | null }) {
  if (!integration) return null
  // Nothing to scan means nothing to say -- but say WHICH nothing, so an empty
  // line is never mistaken for "all clean".
  if (integration.scannedAt == null) {
    return (
      <ScopeSection label="integration">
        <div className="text-[10px] text-fg-faint">no git scan yet</div>
      </ScopeSection>
    )
  }
  const parts: string[] = []
  if (integration.unpushed > 0) parts.push(`${integration.unpushed} unpushed`)
  if (integration.stalled > 0) parts.push(`${integration.stalled} stalled`)
  if (integration.dirty > 0) parts.push(`${integration.dirty} dirty`)
  if (integration.conflicts > 0) parts.push(`${integration.conflicts} conflicting`)
  return (
    <ScopeSection label="integration">
      <div className="text-[10px] text-foreground/85 font-mono">
        {parts.length > 0 ? parts.join(' · ') : `${integration.branches} branches, all integrated`}
      </div>
      {/* The card reads the last snapshot; it never triggers a scan, so the age
          is part of the answer rather than a detail. */}
      <div className="text-[9px] text-fg-faint">scanned {formatAgeShort(integration.scannedAt)} ago</div>
    </ScopeSection>
  )
}

import { BUILD_VERSION } from '../../../../src/shared/version'
import { GroupHeader } from './settings-inputs'

export function versionMatches(filter: string): boolean {
  return 'version build commit'.includes(filter)
}

export function VersionSection() {
  const buildDate = BUILD_VERSION.buildTime
    ? new Date(BUILD_VERSION.buildTime).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      })
    : 'unknown'
  return (
    <div>
      <GroupHeader label="Version" />
      <div className="space-y-2 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">commit</span>
          <span className="text-active">{BUILD_VERSION.gitHashShort}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">built</span>
          <span>{buildDate}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">dirty</span>
          <span>{BUILD_VERSION.dirty ? 'yes' : 'no'}</span>
        </div>
        {BUILD_VERSION.recentCommits?.length > 0 && (
          <div className="border-t border-border pt-2">
            <div className="text-muted-foreground mb-1.5 uppercase tracking-wider text-[10px]">Recent commits</div>
            <div className="space-y-1">
              {BUILD_VERSION.recentCommits.map(c => (
                <div key={c.hash} className="flex gap-2">
                  <span className="text-active shrink-0">{c.hash}</span>
                  <span className="text-foreground/70 truncate">{c.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

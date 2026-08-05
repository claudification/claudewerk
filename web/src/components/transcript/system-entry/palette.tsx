import type { IconName, Severity } from '@shared/system-events'
import { Folder, GitCommitHorizontal, GitMerge, GitPullRequestArrow, Power, Rewind, Shield, Upload } from 'lucide-react'

// The surface half of the event vocabulary: severity -> color, icon name -> component.
// The shared registry decides what an event MEANS; this file is the only place that decides
// what it LOOKS like, so a second surface (a TTY, a notification) can pick its own.

const SEVERITY_COLORS: Record<Severity, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  notice: 'text-orange-300/80',
  info: 'text-cyan-400/70',
  muted: 'text-muted-foreground/70',
}

export function severityColor(severity: Severity): string {
  return SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.muted
}

const ICON_CLASS = 'w-2.5 h-2.5 shrink-0'

const ICONS: Record<IconName, React.ComponentType<{ className?: string }>> = {
  commit: GitCommitHorizontal,
  push: Upload,
  merge: GitMerge,
  rebase: Rewind,
  'pull-request': GitPullRequestArrow,
  worktree: GitMerge,
  folder: Folder,
  shield: Shield,
  power: Power,
}

export function EventIcon({ name }: { name: IconName | undefined }) {
  if (!name) return null
  const Icon = ICONS[name]
  return Icon ? <Icon className={ICON_CLASS} /> : null
}

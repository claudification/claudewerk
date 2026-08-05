import { GitCommitHorizontal, GitMerge, GitPullRequestArrow, Rewind, Upload } from 'lucide-react'
import type { SystemDescriber } from './types'
import { str } from './types'

const ICON_CLASS = 'w-2.5 h-2.5 shrink-0'

/**
 * `kind` is an OPEN set -- CC's own schema says "new kinds may be added; treat
 * an unrecognized kind exactly like a recognized one (something changed, go
 * look)". So this map only supplies the label + icon; an unknown kind still
 * renders, using the raw kind as its label.
 */
const VCS_KINDS: Record<string, { label: string; icon: React.ReactNode }> = {
  commit: { label: 'Committed', icon: <GitCommitHorizontal className={ICON_CLASS} /> },
  push: { label: 'Pushed', icon: <Upload className={ICON_CLASS} /> },
  merge: { label: 'Merged', icon: <GitMerge className={ICON_CLASS} /> },
  rebase: { label: 'Rebased', icon: <Rewind className={ICON_CLASS} /> },
}

/**
 * `system/vcs_state_changed` -- the working tree's git state moved under CC's
 * feet (it observed a commit/push/merge/rebase). `cwd` is the session's working
 * directory, a HINT and not necessarily the mutated repo, so it is deliberately
 * not rendered as a location claim: the JsonInspector carries it.
 */
const vcsStateChanged: SystemDescriber = entry => {
  const kind = str(entry.kind)
  const known = VCS_KINDS[kind]
  return {
    kind: 'text',
    text: known?.label || (kind ? `Repo: ${kind}` : 'Repo state changed'),
    color: 'text-orange-300/70',
    icon: known?.icon,
  }
}

/**
 * `system/code_change_published` -- the session is now linked to a PR/MR. Fires
 * on creation AND on later contributions (gh pr edit/checkout, a push to a
 * branch with an open PR), so the same URL can legitimately appear more than
 * once. Fields are scraped from command output -- display only, never trusted
 * for routing (CC's schema is explicit about this), hence no forge API call
 * here and no provider-specific styling beyond the label.
 */
const codeChangePublished: SystemDescriber = entry => {
  const url = str(entry.url)
  const repo = str(entry.repo)
  const id = str(entry.identifier)
  const provider = str(entry.provider)
  const noun = provider === 'gitlab' ? 'MR' : 'PR'
  // A bare noun is not a label -- with neither an id nor a repo, the url is the
  // only thing that actually identifies the change.
  const label = id || repo ? [id ? `${noun} #${id}` : noun, repo].filter(Boolean).join(' -- ') : ''
  return {
    kind: 'text',
    text: label || url || 'Code change published',
    color: 'text-violet-300/80',
    icon: <GitPullRequestArrow className={ICON_CLASS} />,
    ...(url ? { href: url } : {}),
  }
}

export const VCS_DESCRIBERS: Record<string, SystemDescriber> = {
  vcs_state_changed: vcsStateChanged,
  code_change_published: codeChangePublished,
}

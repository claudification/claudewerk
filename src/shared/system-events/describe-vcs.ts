/** The VCS lane: what happened to the repo under the agent's feet. */
import type { Describer, IconName } from './types'
import { bag, baseName, num, str } from './types'

/**
 * `kind` is an OPEN set -- Claude Code's own schema says "new kinds may be added; treat an
 * unrecognized kind exactly like a recognized one (something changed, go look)". So this map
 * only supplies the label and the icon; an unknown kind still renders, using the raw kind.
 */
const VCS_KINDS: Record<string, { label: string; icon: IconName }> = {
  commit: { label: 'Committed', icon: 'commit' },
  push: { label: 'Pushed', icon: 'push' },
  merge: { label: 'Merged', icon: 'merge' },
  rebase: { label: 'Rebased', icon: 'rebase' },
}

/**
 * `vcs-changed` -- the working tree's git state moved (a commit/push/merge/rebase was
 * observed). `cwd` is the session's working directory, a HINT and not necessarily the mutated
 * repo, so it is deliberately not rendered as a location claim: the JSON inspector carries it.
 */
const vcsChanged: Describer = entry => {
  const kind = str(entry.kind)
  const known = VCS_KINDS[kind]
  return {
    text: known?.label || (kind ? `Repo: ${kind}` : 'Repo state changed'),
    severity: 'notice',
    icon: known?.icon,
  }
}

/**
 * `code-published` -- this conversation is now linked to a pull/merge request. TWO wire
 * shapes reach here: the mid-stream `code_change_published` frame (url/repo/identifier/
 * provider) and the `pr-link` JSONL entry (prUrl/prNumber/prRepository). Same event, one
 * line. It fires on creation AND on later contributions (a `gh pr edit`/`checkout`, a push to
 * a branch with an open PR), so the same URL legitimately appears more than once.
 *
 * Fields are scraped from command output, so they are a display hint, never a routing
 * decision -- hence no forge lookup here.
 */
const codePublished: Describer = entry => {
  const { url, repo, id } = publishedRef(entry)
  const noun = str(entry.provider) === 'gitlab' ? 'MR' : 'PR'
  // A bare noun is not a label -- with neither an id nor a repo, the url is the only thing
  // that actually identifies the change.
  const label = id || repo ? [id ? `${noun} #${id}` : noun, repo].filter(Boolean).join(' -- ') : ''
  return {
    text: label || url || 'Code change published',
    severity: 'notice',
    icon: 'pull-request',
    ...(url ? { href: url } : {}),
  }
}

/** The change's identity, read from either wire shape (mid-stream frame, or `pr-link`). */
function publishedRef(entry: Parameters<Describer>[0]): { url: string; repo: string; id: string } {
  const prNumber = num(entry.prNumber)
  return {
    url: str(entry.url) || str(entry.prUrl),
    repo: str(entry.repo) || str(entry.prRepository),
    id: str(entry.identifier) || (prNumber === undefined ? '' : String(prNumber)),
  }
}

/** `worktree-entered` -- the conversation moved into an isolated worktree. */
const worktreeEntered: Describer = entry => {
  const session = bag(entry.worktreeSession)
  const name = str(session.worktreeName) || baseName(str(session.worktreePath))
  if (!name) return null
  return { text: `Worktree: ${name}`, severity: 'notice', icon: 'worktree' }
}

/** `cwd-relocated` -- the conversation's working directory moved (leaving a worktree). */
const cwdRelocated: Describer = entry => {
  const cwd = str(entry.relocatedCwd)
  return { text: `Moved to ${baseName(cwd) || cwd || 'a new directory'}`, severity: 'muted', icon: 'folder' }
}

export const VCS_DESCRIBERS: Record<string, Describer> = {
  'vcs-changed': vcsChanged,
  'code-published': codePublished,
  'worktree-entered': worktreeEntered,
  'cwd-relocated': cwdRelocated,
}

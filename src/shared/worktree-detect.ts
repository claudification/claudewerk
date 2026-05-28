/**
 * Worktree-name detection from a filesystem path.
 *
 * The project URI already folds worktrees into their parent project via
 * `aliasPath()` in `project-uri.ts` -- worktrees ARE the same project on a
 * branch. This util exists solely so the UI can render a sub-tag ("worktree:
 * fleet-sheaf") under the project bucket without reparsing paths.
 *
 * Returns the worktree name when the path matches a known pattern, else null.
 */

const WORKTREE_PATTERNS: RegExp[] = [
  // Our convention: <project>/.claude/worktrees/<name>(/...)?
  /\/\.claude\/worktrees\/([^/]+)(?:\/|$)/,
  // Generic: <project>/.worktrees/<name>(/...)?
  /\/\.worktrees\/([^/]+)(?:\/|$)/,
]

export function detectWorktreeName(currentPath: string | undefined | null): string | null {
  if (!currentPath) return null
  for (const pattern of WORKTREE_PATTERNS) {
    const match = currentPath.match(pattern)
    if (match) return match[1]
  }
  return null
}

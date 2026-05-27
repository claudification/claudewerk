/**
 * Worktree-path detection.
 *
 * The repo convention (WORK MODE covenant) places worktrees at
 * `{mainProjectPath}/.claude/worktrees/{name}`. When a launch is triggered
 * from inside a worktree path, the spawn dialog wants to default to the
 * main project path but offer a one-click escape hatch back to the
 * worktree. This helper does the path-shape detection.
 */

const WORKTREE_RE = /^(.*?)\/\.claude\/worktrees\/([^/]+)\/?$/

export interface WorktreeContext {
  /** The main project root, e.g. `/Users/jonas/projects/remote-claude`. */
  mainPath: string
  /** The worktree path with any trailing slash stripped. */
  worktreePath: string
  /** The worktree name, e.g. `foo`. */
  worktreeName: string
}

/** Returns context if `path` is a worktree under `.claude/worktrees/`, else null. */
export function detectWorktree(path: string): WorktreeContext | null {
  const m = WORKTREE_RE.exec(path)
  if (!m) return null
  const mainPath = m[1]
  const worktreeName = m[2]
  if (!mainPath || !worktreeName) return null
  return {
    mainPath,
    worktreePath: path.replace(/\/$/, ''),
    worktreeName,
  }
}

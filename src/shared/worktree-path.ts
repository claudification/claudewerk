/**
 * Where a named worktree lives, relative to its project root.
 *
 * The convention (`.claude/worktrees/<name>`, branch `worktree-<name>`) comes
 * from scripts/worktree-create.sh. It is shared rather than re-joined at each
 * call site because two components deriving it independently is exactly how a
 * fork gets written to a directory the launch never looks in.
 */

import { join } from 'node:path'

export function worktreePath(projectCwd: string, name: string): string {
  return join(projectCwd, '.claude', 'worktrees', name)
}

export function worktreeBranch(name: string): string {
  return `worktree-${name}`
}

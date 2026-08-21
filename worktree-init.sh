#!/bin/bash
# worktree-init.sh -- rclaude project worktree setup
# Called by worktree-create.sh after git worktree is created.
# $1 = worktree path

WORKTREE="$1"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Keep the project board out of this worktree's checkout. `.rclaude/project/` is
# a tracked tree; without this, every worktree gets its own stale 628-file copy
# that an agent can commit by accident. See scripts/worktree-sparse-board.sh for
# the full reasoning. A no-op while the board is still gitignored, so it is safe
# to have landed before the first board commit -- which is the point.
SPARSE_BOARD="$PROJECT_ROOT/scripts/worktree-sparse-board.sh"
if [[ -f "$SPARSE_BOARD" ]]; then
  bash "$SPARSE_BOARD" "$WORKTREE" || echo "WARNING: worktree-sparse-board.sh failed" >&2
fi

cd "$WORKTREE" || exit 1
bun install --frozen-lockfile 2>/dev/null || bun install
# Generate src/shared/version.ts (gitignored, not copied into the worktree) so
# typecheck and builds work in a fresh worktree.
bun run gen-version
# web/ is a separate package (not a root workspace) -- install its deps too.
(cd web && (bun install --frozen-lockfile 2>/dev/null || bun install))

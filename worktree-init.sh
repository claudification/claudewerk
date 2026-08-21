#!/bin/bash
# worktree-init.sh -- rclaude project worktree setup
# Called by worktree-create.sh after git worktree is created.
# $1 = worktree path

WORKTREE="$1"

cd "$WORKTREE" || exit 1
bun install --frozen-lockfile 2>/dev/null || bun install
# Generate src/shared/version.ts (gitignored, not copied into the worktree) so
# typecheck and builds work in a fresh worktree.
bun run gen-version
# web/ is a separate package (not a root workspace) -- install its deps too.
(cd web && (bun install --frozen-lockfile 2>/dev/null || bun install))

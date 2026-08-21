#!/bin/bash
#
# worktree-sparse-board.sh -- keep `.rclaude/project/` (the board) out of every
# worktree's checkout.
#
# WHY (2026-08-21, card board-in-worktrees-policy):
# The board is about to become a TRACKED tree (see board-record-durability).
# A git worktree checks out the tracked tree, so the moment that lands, every
# one of the 15+ live worktrees materialises its own 628-file, 4 MB copy of the
# board -- and those copies are stale shadows the instant they exist. The
# sentinel owns board file I/O and works against the project root; nothing syncs
# a worktree's copy, and `project_set_status` writes to the root board. So:
#   - an agent running `git add -A` in a worktree commits its shadow
#   - two branches conflict on a card neither agent meant to touch
#   - every copy drifts from the first status change onward
#
# Sparse-checkout is the only lever where the failure is IMPOSSIBLE rather than
# discouraged: the worktree has no board file, so it cannot commit one. The
# board entries stay in the worktree's index flagged skip-worktree (`S` in
# `git ls-files -t`), so merges and rebases still carry board changes correctly
# -- they just never hit that worktree's disk. Agents reach the real board
# through the sentinel/MCP, which is already how they read it.
#
# `--no-cone` is deliberate. Cone mode can only INCLUDE whole directories, so
# expressing "everything except one subdirectory" there means enumerating every
# top-level directory by hand -- and then a directory added later is silently
# missing from every new worktree. The negation says exactly what is meant.
#
# NON-DESTRUCTIVE BY CONSTRUCTION: git refuses to remove a path with
# uncommitted changes, warns with the path name, and leaves it alone. Other
# agents live in these trees; this script never forces past that, it reports it.
#
# Usage:
#   scripts/worktree-sparse-board.sh <worktree-path>   apply to one worktree
#   scripts/worktree-sparse-board.sh --all             sweep every worktree
#                                                      under .claude/worktrees/
# Exit:
#   0  applied everywhere it was asked to, nothing left behind
#   1  usage error, or the single target was refused/unusable
#   2  applied, but at least one worktree kept board files (dirty or skipped)
#

set -uo pipefail

# The one place the pattern set is written down. Everything else -- the init
# hook, the sweep, the test -- goes through this script so there is no second
# copy to drift.
BOARD_DIR='.rclaude/project'
SPARSE_INCLUDE_ALL='/*'
SPARSE_EXCLUDE_BOARD="!/${BOARD_DIR}/"

usage() {
  echo "usage: $0 <worktree-path> | --all" >&2
  exit 1
}

# Apply to one worktree. Echoes one status line per call:
#   OK <path> | PARTIAL <path> | REFUSED <path> | SKIP <path>
apply_one() {
  local wt="$1"
  local gitdir commondir

  if [[ ! -d "$wt" ]]; then
    echo "SKIP $wt -- not a directory" >&2
    return 2
  fi

  gitdir="$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null)"
  if [[ -z "$gitdir" ]]; then
    echo "SKIP $wt -- not a git working tree" >&2
    return 2
  fi
  commondir="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"

  # THE guard. In the main working tree $GIT_DIR == $GIT_COMMON_DIR, and that
  # tree is where the real board lives -- sparse-checkout there would delete
  # 628 cards off disk. Never.
  if [[ "$gitdir" == "$commondir" ]]; then
    echo "REFUSED $wt -- this is the MAIN working tree; the real board lives here" >&2
    return 1
  fi

  if ! git -C "$wt" sparse-checkout set --no-cone \
      "$SPARSE_INCLUDE_ALL" "$SPARSE_EXCLUDE_BOARD" 2>&1; then
    echo "FAILED $wt -- git sparse-checkout set returned non-zero" >&2
    return 2
  fi

  # git exits 0 even when it declines to remove a modified path (it only warns),
  # so the exit code is not the evidence -- the index is. Anything under the
  # board that is NOT flagged skip-worktree is still a live shadow.
  local left
  left="$(git -C "$wt" ls-files -t -- "$BOARD_DIR" 2>/dev/null | grep -v '^S ' || true)"
  if [[ -n "$left" ]]; then
    echo "PARTIAL $wt -- board files left in place (uncommitted local changes):" >&2
    printf '    %s\n' "$left" >&2
    return 2
  fi

  echo "OK $wt"
  return 0
}

sweep_all() {
  # Read the porcelain in ONE pass and drain it fully. Leaving early gives git
  # SIGPIPE once the output stops fitting the 64 KB pipe buffer, which this repo
  # passed at ~400 worktrees -- the same trap documented in worktree-create.sh.
  local list
  list="$(git worktree list --porcelain 2>/dev/null)"
  if [[ -z "$list" ]]; then
    echo "no worktrees found (is this a git repo?)" >&2
    return 1
  fi

  local ok=0 bad=0 line path rc
  local -a problems=()
  while IFS= read -r line; do
    [[ "$line" == "worktree "* ]] || continue
    path="${line#worktree }"
    # Only OUR worktrees. `git worktree list` also reports the main checkout and
    # every throwaway tree other tooling parks in $TMPDIR (fallow audit caches,
    # guard fixtures); sweeping those is pointless and slow.
    [[ "$path" == *"/.claude/worktrees/"* ]] || continue
    apply_one "$path"
    rc=$?
    if [[ $rc -eq 0 ]]; then
      ok=$((ok + 1))
    else
      bad=$((bad + 1))
      problems+=("$path")
    fi
  done <<< "$list"

  echo "swept $ok worktree(s) clean, $bad left board files"
  if [[ $bad -gt 0 ]]; then
    echo "not fully swept -- rerun after these are committed or cleaned:" >&2
    printf '    %s\n' "${problems[@]}" >&2
    return 2
  fi
  return 0
}

[[ $# -eq 1 ]] || usage

if [[ "$1" == "--all" ]]; then
  sweep_all
  exit $?
fi

case "$1" in
  -*) usage ;;
esac

apply_one "$1"
exit $?

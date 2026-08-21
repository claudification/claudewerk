#!/bin/bash
#
# worktree-finish.sh - Merge worktree branch back to main
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# Rebases the current worktree branch onto main, then fast-forwards main to
# include the worktree's work -- by merging --ff-only inside whichever working
# tree has main checked out (git 2.54 forbids moving a checked-out ref).
#
# Usage: bash scripts/worktree-finish.sh
#
# Exit codes:
#   0 = success (or nothing to merge)
#   1 = error (uncommitted changes, rebase conflict, etc.)
#

set -euo pipefail

# Detect current state
BRANCH="$(git branch --show-current)"
if [[ ! "$BRANCH" =~ ^worktree- ]]; then
  echo "Not in a worktree branch ($BRANCH)" >&2
  exit 1
fi

# Find the main branch
MAIN_BRANCH="main"
if ! git rev-parse --verify main >/dev/null 2>&1; then
  MAIN_BRANCH="master"
fi

# Check if there are uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes. Commit or stash first." >&2
  exit 1
fi

# Check untracked files too
UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
if [[ "$UNTRACKED" -gt 0 ]]; then
  echo "WARNING: $UNTRACKED untracked files (not blocking merge)" >&2
fi

# Check if there's anything to merge
AHEAD="$(git rev-list --count "$MAIN_BRANCH"..HEAD)"
if [[ "$AHEAD" == "0" ]]; then
  echo "Nothing to merge -- worktree branch is even with $MAIN_BRANCH"
  exit 0
fi

# Rebase onto main
echo "Rebasing $BRANCH onto $MAIN_BRANCH ($AHEAD commits ahead)..."
if ! git rebase "$MAIN_BRANCH"; then
  echo "ERROR: Rebase conflicts. Resolve them, then run:" >&2
  echo "  git rebase --continue" >&2
  echo "  bash scripts/worktree-finish.sh" >&2
  exit 1
fi

# Fast-forward $MAIN_BRANCH to this worktree's HEAD.
#
# The old "merge without a checkout" trick, git fetch . HEAD:$MAIN_BRANCH, is
# DEAD as of git 2.54: git refuses to move a ref checked out in ANY working
# tree, and $MAIN_BRANCH is permanently checked out at the repo root. The guard
# is CORRECT -- moving the ref under a live checkout leaves that tree's index
# disagreeing with HEAD, so the root would show the merged files as uncommitted
# REVERSALS. So do the merge INSIDE the tree that owns the branch.
#
# --ff-only can only advance the ref, never rewrite it, and it aborts without
# touching anything if a locally-modified file would be overwritten, so it
# cannot eat another agent's uncommitted work. Dirt on files the merge does NOT
# touch is fine and is deliberately NOT a blocker: with a dozen live agents,
# main is almost always dirty on something.
#
# Fallback: when $MAIN_BRANCH is checked out NOWHERE (bare repo, CI) the old
# fetch is still correct and still permitted.
ff_main() {
  FF_SHA="$(git rev-parse --verify HEAD)"
  # No early exit in this awk. Leaving while git is still writing SIGPIPEs it;
  # pipefail promotes 141 and set -e then kills the script silently inside the
  # command substitution. That scar is commit 7115f480 -- drain the whole stream.
  FF_MAIN_WT="$(git worktree list --porcelain 2>/dev/null | awk -v b="branch refs/heads/$MAIN_BRANCH" '/^worktree / {cur=substr($0,10); next} $0==b {print cur}')"
  if [[ -z "$FF_MAIN_WT" ]]; then
    git fetch . "HEAD:$MAIN_BRANCH"
    return
  fi
  git -C "$FF_MAIN_WT" merge --ff-only "$FF_SHA"
}

echo "Fast-forwarding $MAIN_BRANCH..."
if ! ff_main; then
  echo "ERROR: Cannot fast-forward $MAIN_BRANCH -- git's reason is above." >&2
  echo "Most likely the $MAIN_BRANCH checkout has local edits to a file this merge touches," >&2
  echo "or $MAIN_BRANCH moved on and no longer fast-forwards. Nothing was changed." >&2
  exit 1
fi

echo "Merged $AHEAD commits from $BRANCH into $MAIN_BRANCH"

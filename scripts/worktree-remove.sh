#!/bin/bash
#
# worktree-remove.sh - WorktreeRemove hook
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# BLOCKS removal if the worktree branch has unmerged commits.
# Only allows removal when all work has been merged to main.
#
# Input (stdin JSON from CC):
#   { session_id, cwd, hook_event_name, name, path }
#

set -euo pipefail

HOOK_DATA=$(cat)
WT_NAME=$(echo "$HOOK_DATA" | jq -r '.name // "unknown"')
WT_PATH=$(echo "$HOOK_DATA" | jq -r '.path // empty')

# Fallback: derive path from name + cwd
if [[ -z "$WT_PATH" ]]; then
  WT_CWD=$(echo "$HOOK_DATA" | jq -r '.cwd // empty')
  if [[ -n "$WT_CWD" && -n "$WT_NAME" && "$WT_NAME" != "unknown" ]]; then
    WT_PATH="$WT_CWD/.claude/worktrees/$WT_NAME"
  fi
fi

if [[ -z "$WT_PATH" || ! -d "$WT_PATH" ]]; then
  # Worktree already gone or never created -- allow removal
  exit 0
fi

cd "$WT_PATH" 2>/dev/null || exit 0

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

BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
MAIN_BRANCH="main"
git rev-parse --verify main >/dev/null 2>&1 || MAIN_BRANCH="master"

if [[ -n "$BRANCH" ]]; then
  UNCOMMITTED="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  AHEAD="$(git rev-list --count "$MAIN_BRANCH..HEAD" 2>/dev/null || echo 0)"

  if [[ "$UNCOMMITTED" -gt 0 ]]; then
    echo "BLOCKED: Worktree $BRANCH has $UNCOMMITTED uncommitted files. Commit or discard first." >&2
    exit 1
  fi

  if [[ "$AHEAD" -gt 0 ]]; then
    # Try fast-forward merge before blocking.
    #
    # NEVER swallow the failure. This used to be `... 2>/dev/null` and reported
    # every failure as "unmerged commits that cannot be fast-forwarded" -- which
    # was a LIE once git started refusing the fetch outright: the commits merged
    # perfectly, git just was not allowed to say so, and clean worktrees piled up
    # refusing to be removed. Print git's own reason so a real conflict and a
    # tooling failure can never again look identical.
    if FF_OUT="$(ff_main 2>&1)"; then
      echo "Auto-merged $AHEAD commits from $BRANCH to $MAIN_BRANCH before removal" >&2
    else
      echo "BLOCKED: Worktree $BRANCH has $AHEAD commits that could not be fast-forwarded to $MAIN_BRANCH:" >&2
      echo "$FF_OUT" >&2
      exit 1
    fi
  fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') REMOVE worktree=$WT_NAME branch=$BRANCH (merged)" >> /tmp/rclaude-worktree.log 2>/dev/null || true
exit 0

#!/bin/bash
#
# worktree-create.sh - WorktreeCreate hook for Claude Code
#
# NOTE: Canonical source is embedded in src/shared/resolve-script.ts.
# This file is for dev/reference. Keep in sync with the embedded version.
#
# Creates git worktrees from LOCAL HEAD instead of origin/HEAD.
# CC defaults to origin/HEAD (last pushed commit), which creates
# stale branches when you have unpushed local commits.
#
# Input (stdin JSON from CC):
#   { session_id, transcript_path, cwd, hook_event_name, name }
#   - name: worktree name from --worktree flag
#   - cwd: project root directory
#
# Output: worktree path to stdout, exit 0 = success
#

set -euo pipefail

HOOK_DATA=$(cat)
WT_NAME=$(echo "$HOOK_DATA" | jq -r '.name // empty')

if [[ -z "$WT_NAME" ]]; then
  echo "ERROR: No worktree name in hook data" >&2
  exit 1
fi

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_PATH="$PROJECT_ROOT/.claude/worktrees/$WT_NAME"

# Ensure parent dir exists
mkdir -p "$(dirname "$WORKTREE_PATH")"

# Resolve base: local branch HEAD > main > fallback
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  REAL_BASE="HEAD"
elif [[ -n "$CURRENT_BRANCH" ]]; then
  REAL_BASE="$CURRENT_BRANCH"
else
  REAL_BASE="main"
fi

REAL_BASE_SHA="$(git rev-parse "$REAL_BASE")"
BRANCH_NAME="worktree-$WT_NAME"

# CRITICAL: CC expects ONLY the worktree path on stdout.
# All other output (git, bun install, init scripts) MUST go to stderr.
#
# Idempotency: if a previous spawn already created this worktree and/or
# branch, reuse it instead of failing on "branch already exists" / "path
# already used". This makes the hook safe to re-run when a parent spawns
# multiple children into the same worktree (e.g. chain protocol phases).
#
# awk MUST NOT `exit` on the match, and `| head -1` is the same bug one stage
# later. Leaving early while `git worktree list` is still writing gives git
# SIGPIPE -> 141; `pipefail` promotes it and `set -e` aborts -- silently, because
# this is a command-substitution assignment. That killed every spawn into an
# existing worktree once this repo passed ~400 worktrees (the output stopped
# fitting the 64 KB pipe buffer). Draining costs one pass over the porcelain,
# which is nothing next to the `git worktree add` below.
EXISTING_WT_BRANCH="$(git worktree list --porcelain 2>/dev/null \
  | awk -v p="$WORKTREE_PATH" '
      /^worktree / {cur=$2; next}
      /^branch refs\/heads\// && cur==p {sub(/^branch refs\/heads\//,""); print}
    ')"
SKIP_INIT=
if [[ "$EXISTING_WT_BRANCH" == "$BRANCH_NAME" ]]; then
  echo "WorktreeCreate: REUSE existing worktree at $WORKTREE_PATH (branch=$BRANCH_NAME)" >&2
  SKIP_INIT=1
elif [[ -n "$EXISTING_WT_BRANCH" ]]; then
  echo "ERROR: $WORKTREE_PATH is already a worktree for branch '$EXISTING_WT_BRANCH' (wanted '$BRANCH_NAME')" >&2
  exit 1
elif git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "WorktreeCreate: ATTACH existing branch $BRANCH_NAME to $WORKTREE_PATH" >&2
  git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" >&2
else
  git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$REAL_BASE_SHA" >&2
fi

# Copy .worktreeinclude files (our hook replaces CC's native logic).
# Skip on reuse -- already copied at original creation.
if [[ -z "$SKIP_INIT" && -f "$PROJECT_ROOT/.worktreeinclude" ]]; then
  while IFS= read -r pattern || [[ -n "$pattern" ]]; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    # shellcheck disable=SC2086
    for file in $PROJECT_ROOT/$pattern; do
      [[ -f "$file" ]] || continue
      if git check-ignore -q "$file" 2>/dev/null; then
        REL="${file#$PROJECT_ROOT/}"
        mkdir -p "$(dirname "$WORKTREE_PATH/$REL")"
        cp "$file" "$WORKTREE_PATH/$REL"
      fi
    done
  done < "$PROJECT_ROOT/.worktreeinclude"
fi

# Run worktree-init.sh if it exists (all output to stderr).
# Skip on reuse -- init already ran at original creation.
INIT_SCRIPT="$PROJECT_ROOT/worktree-init.sh"
if [[ -z "$SKIP_INIT" ]]; then
  if [[ -x "$INIT_SCRIPT" ]]; then
    "$INIT_SCRIPT" "$WORKTREE_PATH" >&2 || echo "WARNING: worktree-init.sh failed" >&2
  elif [[ -f "$INIT_SCRIPT" ]]; then
    bash "$INIT_SCRIPT" "$WORKTREE_PATH" >&2 || echo "WARNING: worktree-init.sh failed" >&2
  fi
fi

# Exclude this worktree's node_modules from Time Machine.
#
# WHY (2026-08-13 incident): every worktree's install drops ~6.5k files into a
# tree Time Machine would otherwise scan and back up. With 70+ live worktrees
# that was ~460k transient files feeding TM's change-scan -- and backupd was the
# ONLY FSEvents client whose buffer overflowed (11558 of 11559 USER DROPPED
# events in 24h) while fseventsd sat on 16.5 GB of retained events and the box
# ran out of swap. node_modules is fully reproducible from the lockfile, so
# backing it up buys nothing and costs a lot.
#
# Writes the xattr directly instead of shelling out to `tmutil addexclusion`,
# which round-trips through backupd and measured ~11s per call (a full sweep of
# 647 dirs would have taken ~2h). The value is byte-identical to what tmutil
# writes; confirmed with `tmutil isexcluded`. Never gates worktree creation --
# this is an optimisation, and a failure here must not cost the user a worktree.
TM_EXCLUDE_XATTR='62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C'
if command -v xattr >/dev/null 2>&1; then
  while IFS= read -r NM_DIR; do
    [[ -n "$NM_DIR" ]] || continue
    # Deliberately no backslash line-continuation: this script is ALSO embedded
    # in a JS template literal (src/shared/resolve-script.ts), where a trailing
    # backslash-newline is a JS escape and gets swallowed, silently reflowing
    # the command. An if-block survives both copies intact.
    if xattr -wx com.apple.metadata:com_apple_backup_excludeItem "$TM_EXCLUDE_XATTR" "$NM_DIR" 2>/dev/null; then
      echo "WorktreeCreate: Time Machine exclusion set on $NM_DIR" >&2
    fi
  done < <(find "$WORKTREE_PATH" -type d -name node_modules -prune 2>/dev/null)
fi

# ONLY output: the worktree path
echo "$WORKTREE_PATH"

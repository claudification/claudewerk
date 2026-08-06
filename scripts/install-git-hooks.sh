#!/bin/bash
# Install the CLAUDEWERK commit-ledger post-commit hook into a repository.
#
#   scripts/install-git-hooks.sh [repo-path]   # install (default: this repo)
#   scripts/install-git-hooks.sh --uninstall [repo-path]
#   scripts/install-git-hooks.sh --status [repo-path]
#
# Idempotent. Hooks live in the git COMMON dir, so installing once covers the
# main checkout AND every worktree under .claude/worktrees/ -- verified:
# `git rev-parse --git-path hooks` from inside a linked worktree resolves to the
# main repo's .git/hooks.
#
# If a post-commit hook already exists it is CHAINED, never clobbered: the
# existing script is preserved and invoked first.

set -euo pipefail

MARKER="# >>> claudewerk commit-ledger >>>"
END_MARKER="# <<< claudewerk commit-ledger <<<"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_HOOK="$SCRIPT_DIR/git-hooks/post-commit"

mode=install
repo=.
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --status) mode=status ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) repo=$arg ;;
  esac
done

cd "$repo"
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks 2>/dev/null) || {
  echo "not a git repository: $repo" >&2
  exit 1
}
mkdir -p "$hooks_dir"
target="$hooks_dir/post-commit"

case "$mode" in
  status)
    if [ -f "$target" ] && grep -qF "$MARKER" "$target"; then
      echo "installed: $target"
    else
      echo "not installed ($target)"
    fi
    exit 0
    ;;

  uninstall)
    if [ ! -f "$target" ] || ! grep -qF "$MARKER" "$target"; then
      echo "not installed, nothing to do"
      exit 0
    fi
    # Strip only our block; anything chained around it survives.
    tmp=$(mktemp)
    sed "/$MARKER/,/$END_MARKER/d" "$target" >"$tmp"
    if [ -s "$tmp" ] && grep -qv '^#!' "$tmp"; then
      mv "$tmp" "$target"
      chmod +x "$target"
      echo "removed the ledger block, kept the rest of $target"
    else
      rm -f "$tmp" "$target"
      echo "removed $target"
    fi
    exit 0
    ;;
esac

# ─── install ────────────────────────────────────────────────────────────────
if [ -f "$target" ] && grep -qF "$MARKER" "$target"; then
  # Re-install: strip the old block so the payload below is always current.
  tmp=$(mktemp)
  sed "/$MARKER/,/$END_MARKER/d" "$target" >"$tmp"
  mv "$tmp" "$target"
fi

if [ ! -f "$target" ]; then
  printf '#!/bin/bash\n' >"$target"
elif [ -s "$target" ]; then
  echo "chaining onto the existing post-commit hook at $target"
fi

{
  printf '\n%s\n' "$MARKER"
  # The hook body is INLINED rather than sourced from the repo: the ledger must
  # keep working in a checkout of any branch, including one where this repo's
  # scripts/ dir doesn't exist yet.
  tail -n +2 "$SOURCE_HOOK"
  printf '%s\n' "$END_MARKER"
} >>"$target"

chmod +x "$target"
echo "installed commit-ledger hook: $target"
echo "covers: $(git rev-parse --path-format=absolute --git-common-dir) (main checkout + every linked worktree)"
echo "disable without uninstalling: export RCLAUDE_COMMIT_LEDGER=0"

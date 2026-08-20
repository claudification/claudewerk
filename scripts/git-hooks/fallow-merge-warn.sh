#!/usr/bin/env bash
# Warn -- never block -- when a MERGE lands a fallow finding.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# `.claude/hooks/fallow-gate.sh` is a Claude Code PreToolUse hook that matches
# `git commit` / `git push` and blocks on a `fail` verdict. `git merge` writes a
# commit object without ever invoking `git commit`, so the gate never fired for
# a merge: 25 merges onto `main` during epic-the-wall-ii landed unaudited, and a
# CRAP regression in `SheafPane` reached `main` that way -- two branches each
# under the bar, the merged component over it, nobody looking at the sum.
#
# Two properties of that gate make it the wrong place to fix this:
#
#   1. It BLOCKS. Two independently-approved green branches can sum to a `fail`
#      that neither one owns and neither one can fix. Blocking there freezes the
#      whole fleet with no escape but suppression (forbidden) or banking the
#      debt as `inherited`. So: warn, always exit 0.
#   2. It is a PRE hook. It measures the tree in FRONT of the command -- for a
#      merge, the pre-merge tree, which by definition cannot contain the sum. A
#      summed regression is only visible AFTER the merge writes. So: a git
#      post-hook, not a PreToolUse hook.
#
# Base selection is what makes the sum visible: `--changed-since HEAD^1` scopes
# the audit to what THIS merge contributed, measured against the tree we were
# standing on, on the post-merge working tree. A finding present in the first
# parent comes back `inherited`; a finding that only exists once both sides are
# summed comes back `introduced: true`.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   fallow-merge-warn.sh --event merge    # from .git/hooks/post-merge
#   fallow-merge-warn.sh --event commit   # from .git/hooks/post-commit
#
# `--event commit` audits ONLY when HEAD is a merge commit (2+ parents), because
# a conflicted merge finished with `git merge --continue` or `git commit` fires
# post-commit and NOT post-merge. Ordinary commits are already covered by the
# PreToolUse gate and are skipped here.
#
# Kill switch: RCLAUDE_FALLOW_MERGE_WARN=0

set -uo pipefail

TMP_JSON=""
TMP_ERR=""
# ALWAYS exit 0. Warn-never-block is the ruling, and a post-hook that failed
# could not un-write the merge anyway. The trap covers early failures too.
cleanup() {
  [ -n "$TMP_JSON" ] && rm -f "$TMP_JSON"
  [ -n "$TMP_ERR" ] && rm -f "$TMP_ERR"
  exit 0
}
trap cleanup EXIT

[ "${RCLAUDE_FALLOW_MERGE_WARN:-1}" = "0" ] && exit 0
# Re-entrancy guard: `fallow audit` materialises the base snapshot in a scratch
# git worktree. Should any future fallow version reach a merge in there, this
# stops an audit from recursively triggering itself.
[ "${FALLOW_MERGE_WARN_RUNNING:-0}" = "1" ] && exit 0

EVENT=merge
while [ $# -gt 0 ]; do
  case "$1" in
    --event)
      EVENT="${2:-merge}"
      shift 2
      ;;
    *) shift ;;
  esac
done

command -v git >/dev/null 2>&1 || exit 0
git rev-parse --verify --quiet HEAD >/dev/null 2>&1 || exit 0

# `git rev-list --parents -n1` prints "<sha> <parent>..." -- 3+ fields means a
# merge commit. `wc -w` pads on BSD, so count with awk instead.
FIELDS="$(git rev-list --parents -n 1 HEAD 2>/dev/null | awk '{print NF}')"
FIELDS="${FIELDS:-0}"

if [ "$FIELDS" -ge 3 ]; then
  BASE="$(git rev-parse --verify --quiet 'HEAD^1')" || exit 0
  WHAT="merge commit $(git rev-parse --short HEAD)"
elif [ "$EVENT" = "merge" ]; then
  # Fast-forward merge: no merge commit was written, but the tree still moved.
  # `git merge` sets ORIG_HEAD to where we stood before it ran.
  BASE="$(git rev-parse --verify --quiet ORIG_HEAD)" || exit 0
  [ -z "$BASE" ] && exit 0
  [ "$BASE" = "$(git rev-parse HEAD)" ] && exit 0
  WHAT="fast-forward to $(git rev-parse --short HEAD)"
else
  # Ordinary commit. The PreToolUse gate already audited it, and it blocks.
  exit 0
fi
[ -z "$BASE" ] && exit 0

command -v jq >/dev/null 2>&1 || {
  echo "fallow-merge-warn: jq not on PATH, skipping merge audit." >&2
  exit 0
}

TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
if command -v fallow >/dev/null 2>&1; then
  RUNNER=(fallow)
elif [ -x "$TOPLEVEL/node_modules/.bin/fallow" ]; then
  RUNNER=("$TOPLEVEL/node_modules/.bin/fallow")
elif command -v npx >/dev/null 2>&1 && VER_PROBE="$(npx --no-install fallow --version 2>/dev/null || true)" && [[ "$VER_PROBE" == fallow* ]]; then
  RUNNER=(npx --no-install fallow)
else
  echo "fallow-merge-warn: fallow binary not found, skipping merge audit." >&2
  exit 0
fi

TMP_JSON="$(mktemp)"
TMP_ERR="$(mktemp)"

FALLOW_MERGE_WARN_RUNNING=1 "${RUNNER[@]}" audit \
  --format json --quiet --explain --changed-since "$BASE" \
  >"$TMP_JSON" 2>"$TMP_ERR"
STATUS=$?

VERDICT="$(jq -r '.verdict // empty' <"$TMP_JSON" 2>/dev/null || true)"
if [ -z "$VERDICT" ]; then
  ERR_LINE="$(head -n 1 "$TMP_ERR" 2>/dev/null || true)"
  echo "fallow-merge-warn: audit produced no verdict (exit $STATUS${ERR_LINE:+, $ERR_LINE}), skipping." >&2
  exit 0
fi

CHANGED="$(jq -r '.changed_files_count // 0' <"$TMP_JSON")"
BASE_SHORT="$(git rev-parse --short "$BASE")"

if [ "$VERDICT" = "pass" ]; then
  echo "fallow-merge-warn: $WHAT -- audited $CHANGED changed files vs $BASE_SHORT: pass" >&2
  exit 0
fi

REPORT="$(git rev-parse --path-format=absolute --git-dir)/fallow-merge-warn-last.json"
cp "$TMP_JSON" "$REPORT" 2>/dev/null || REPORT="$TMP_JSON"

{
  echo "──────────────────────────────────────────────────────────────────────"
  echo "fallow-merge-warn: verdict '$VERDICT' on $WHAT"
  echo "  base    : $BASE_SHORT (first parent -- what this merge was added to)"
  echo "  changed : $CHANGED files"
  jq -r '.attribution // {} | "  new     : \(.complexity_introduced // 0) complexity, \(.dead_code_introduced // 0) dead-code, \(.duplication_introduced // 0) duplication"' <"$TMP_JSON"
  jq -r '.attribution // {} | "  carried : \(.complexity_inherited // 0) complexity, \(.dead_code_inherited // 0) dead-code, \(.duplication_inherited // 0) duplication"' <"$TMP_JSON"
  echo "──────────────────────────────────────────────────────────────────────"
  jq -r '
    (.complexity.findings // [])[]
    | select(.introduced == true)
    | "  complexity  \(.path):\(.line)  \(.name)  crap=\(.crap) cyclomatic=\(.cyclomatic) (\(.exceeded // "threshold"))"
  ' <"$TMP_JSON" 2>/dev/null || true
  jq -r '
    (.dead_code // {}) | to_entries[]
    | select(.value | type == "array") | .key as $kind
    | .value[] | select(.introduced == true)
    | "  \($kind)  \(.file // .path // "?")  \(.name // .symbol // "")"
  ' <"$TMP_JSON" 2>/dev/null || true
  jq -r '
    (.duplication.clone_groups // [])[]
    | select(.introduced == true)
    | "  duplication  \((.instances // [])[0].path // "?")  \(.line_count // "?") lines x \((.instances // []) | length)"
  ' <"$TMP_JSON" 2>/dev/null || true
  echo "──────────────────────────────────────────────────────────────────────"
  echo "  NOTHING IS BLOCKED -- the merge already wrote. This is the one moment"
  echo "  both parents are in hand, which is the only moment a SUMMED finding is"
  echo "  diagnosable: neither branch may own it on its own."
  echo "  full report: $REPORT"
  echo "  silence it : RCLAUDE_FALLOW_MERGE_WARN=0"
  echo "──────────────────────────────────────────────────────────────────────"
} >&2

exit 0

#!/usr/bin/env bash
#
# bun-test.sh - wall-clock guard around `bun test`.
#
# bun's own `--timeout` bounds an individual TEST, not the RUNNER. A suite that
# leaves a handle open, or spawns a child that never exits, hangs forever and
# prints nothing. On 2026-08-13 a full-suite run sat at 65+ minutes producing
# zero output while the agent that started it kept reporting "waiting on tests".
# The same suite had completed in 66s minutes earlier.
#
# So: every `bun test` entry point goes through here and dies on a budget.
#
#   TEST_TIMEOUT=<seconds>   override the budget (default 600)
#
# Exit 124 means the guard fired -- that is a HANG, not a slow suite. Read it as
# a failure and find the test that never released, do not just raise the budget.
#
# Deliberately NOT applied to `test:watch`, which is meant to run until stopped.

set -uo pipefail

BUDGET="${TEST_TIMEOUT:-600}"

# --- one suite at a time, across every worktree --------------------------
#
# This box hosts a dozen agents, each in its own worktree, each running the
# full suite whenever it likes. Vitest and bun both size their worker pools as
# if they owned the machine, so two concurrent runs on 10 cores means ~20
# workers, and on 2026-08-19 the load average hit 162 with 0% idle while five
# suites fought each other. Every one of them then ran several times slower
# than it would have run alone -- the work was not merely shared out, it was
# multiplied, because the losers keep paying setup and import costs while
# descheduled.
#
# So runs QUEUE instead of trampling. The lock lives in the git common dir,
# which every worktree of this repo resolves to the same path (unlike $PWD,
# which is per-worktree and would hand out one lock each).
#
# macOS has no flock; /usr/bin/shlock is the BSD equivalent and, unlike a bare
# mkdir mutex, it stores the holder's PID and reclaims the lock automatically
# when that process died without cleaning up -- which is exactly how the two
# 4-hour zombie runs would otherwise have wedged the queue forever.
#
#   TEST_NO_LOCK=1        skip the queue entirely
#   TEST_LOCK_WAIT=<secs> give up waiting and run anyway (default 900)

acquire_suite_lock() {
  [[ -n "${TEST_NO_LOCK:-}" ]] && return 0
  command -v shlock >/dev/null 2>&1 || return 0

  local lock waited limit
  lock="$(git rev-parse --git-common-dir 2>/dev/null || echo .)/rclaude-suite.lock"
  limit="${TEST_LOCK_WAIT:-900}"
  waited=0

  while ! shlock -f "$lock" -p $$; do
    if ((waited == 0)); then
      echo "bun-test.sh: another suite is running (holder pid $(cat "$lock" 2>/dev/null | tr -d ' '))" >&2
      echo "  waiting for it rather than competing for cores; TEST_NO_LOCK=1 to skip." >&2
    fi
    if ((waited >= limit)); then
      echo "bun-test.sh: waited ${limit}s for the suite lock -- running anyway." >&2
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done

  SUITE_LOCK="$lock"
  trap 'rm -f "$SUITE_LOCK"' EXIT
  ((waited > 0)) && echo "bun-test.sh: acquired the suite lock after ${waited}s." >&2
  return 0
}

acquire_suite_lock

# --- reap what the suite leaks ------------------------------------------
#
# The wall-clock budget below kills the RUNNER, but a child the runner spawned
# is already reparented to init by then and survives the kill -- so the budget
# stops the hang without cleaning up what caused it. On 2026-08-20 a fixture
# that leaks one plain and one detached child confirmed both outlive a normal
# run; with --no-orphans both were reaped, detached included.
#
# Present since at least 1.3.14, so this is not gated on the 1.4 upgrade.
#
# Deliberately NOT set anywhere near the sentinel's agent-host spawn path: it
# kills DETACHED descendants too, which is exactly the property that makes hosts
# outlive a sentinel restart (HOST_DETACH_NOTE in src/sentinel/index.ts).
# --- which bun runs the suite -------------------------------------------
#
# Defaults to whatever `bun` is on PATH. The override exists so the suite can
# run on a NEWER bun than the machine's global one.
#
# That distinction matters here: ~48 agent hosts and the sentinel all launch via
# `#!/usr/bin/env bun`, so upgrading the global bun re-runtimes the entire fleet
# on the next spawn. Testing against a new bun should not require betting the
# fleet on it.
#
#   BUN_TEST_BIN=/path/to/bun   run the suite on that binary instead
#
# Measured 2026-08-20: 1.4.0 via this override cut the suite 74s -> 20s with
# identical pass/fail counts, while the global bun stayed 1.3.14.
BUN_BIN="${BUN_TEST_BIN:-bun}"
if ! command -v "$BUN_BIN" >/dev/null 2>&1 && [[ ! -x "$BUN_BIN" ]]; then
  echo "bun-test.sh: BUN_TEST_BIN='$BUN_BIN' is not executable" >&2
  exit 1
fi
[[ -n "${BUN_TEST_BIN:-}" ]] && echo "bun-test.sh: using $BUN_BIN ($("$BUN_BIN" --version))" >&2

ORPHAN_GUARD=()
if "$BUN_BIN" test --help 2>&1 | grep -q -- '--no-orphans'; then
  ORPHAN_GUARD=(--no-orphans)
else
  echo "bun-test.sh: this bun has no --no-orphans -- leaked children will survive the run" >&2
fi

# --- fan the suite across cores (bun >= 1.4) ----------------------------
#
# Measured 2026-08-20 on 601 files / 7453 tests, same 1.4 binary both arms:
# sequential 74s, --parallel 20s, with identical pass/skip/fail AND identical
# expect() counts -- so nothing is being silently skipped.
#
# Safe here specifically BECAUSE of the suite lock above: --parallel claims a
# worker per core, which is the exact resource the lock is serialising. One
# locked suite owning all cores is the intent; two would be the 2026-08-19
# load-162 incident again.
#
#   TEST_NO_PARALLEL=1   force the old one-file-at-a-time behaviour
PARALLEL=()
if [[ -z "${TEST_NO_PARALLEL:-}" ]] && "$BUN_BIN" test --help 2>&1 | grep -q -- '--parallel'; then
  PARALLEL=(--parallel)
fi

# coreutils on macOS installs as `gtimeout` unless the gnubin path is active.
# --foreground keeps bun attached to the terminal so its output still streams;
# --kill-after upgrades to SIGKILL for a runner that ignores SIGTERM (which is
# precisely the failure mode this guards).
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

if [[ -z "$TIMEOUT_BIN" ]]; then
  echo "bun-test.sh: no timeout binary found (install coreutils) -- running UNGUARDED" >&2
  exec "$BUN_BIN" test "${ORPHAN_GUARD[@]}" "${PARALLEL[@]}" "$@"
fi

"$TIMEOUT_BIN" --foreground --kill-after=30s "$BUDGET" "$BUN_BIN" test "${ORPHAN_GUARD[@]}" "${PARALLEL[@]}" "$@"
status=$?

if [[ $status -eq 124 || $status -eq 137 ]]; then
  echo "" >&2
  echo "bun-test.sh: KILLED after ${BUDGET}s wall clock -- the runner hung." >&2
  echo "  A test left a handle or child process open; it is not merely slow." >&2
  echo "  Re-run a narrower path to find it, or raise with TEST_TIMEOUT=<seconds>." >&2
fi

exit $status

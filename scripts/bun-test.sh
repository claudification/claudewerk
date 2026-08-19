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

# coreutils on macOS installs as `gtimeout` unless the gnubin path is active.
# --foreground keeps bun attached to the terminal so its output still streams;
# --kill-after upgrades to SIGKILL for a runner that ignores SIGTERM (which is
# precisely the failure mode this guards).
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

if [[ -z "$TIMEOUT_BIN" ]]; then
  echo "bun-test.sh: no timeout binary found (install coreutils) -- running UNGUARDED" >&2
  exec bun test "$@"
fi

"$TIMEOUT_BIN" --foreground --kill-after=30s "$BUDGET" bun test "$@"
status=$?

if [[ $status -eq 124 || $status -eq 137 ]]; then
  echo "" >&2
  echo "bun-test.sh: KILLED after ${BUDGET}s wall clock -- the runner hung." >&2
  echo "  A test left a handle or child process open; it is not merely slow." >&2
  echo "  Re-run a narrower path to find it, or raise with TEST_TIMEOUT=<seconds>." >&2
fi

exit $status

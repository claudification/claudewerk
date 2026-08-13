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

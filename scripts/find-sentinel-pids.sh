#!/bin/bash
#
# find-sentinel-pids.sh - identify RUNNING SENTINEL processes, and nothing else.
#
# Reads `ps -eo pid=,args=` on stdin (so it is testable with a fixture) and
# writes one PID per line for every process that is genuinely a sentinel.
#
# THE INCIDENT THIS EXISTS TO PREVENT (2026-08-17): start-sentinel.sh matched
# orphans with `ps aux | grep "[b]un.*sentinel"` -- a substring match against
# the ENTIRE command line. An agent host runs as
#
#   claude --print ... --append-system-prompt <several KB of text>
#
# and that text routinely contains both "bundle" (which matches `[b]un`) and
# "sentinel". So six live conversations were matched as orphaned sentinels and
# killed. Every one of them belonged to the claudewerk project, because only
# those carry a system prompt describing the sentinel.
#
# THE RULE: identity is argv[0]+argv[1], never a substring of the whole line.
# A sentinel is `bun <path>/sentinel` -- the runtime, then a program whose
# basename is exactly `sentinel`. Arguments after that are irrelevant, and no
# amount of prose in argv[9] can make a process into a sentinel.

set -euo pipefail

# `read` splits on whitespace, so the first three fields fall straight out of
# `ps -eo pid=,args=` (<pid> <argv0> <argv1> <rest>) with no awk and no subshell
# -- this runs once per process on the box, so per-line forks are not free.
#
# Basenames come from `${var##*/}`, NOT `basename`: a login shell reports argv0
# as `-zsh`, and `basename -zsh` parses the leading dash as a flag and errors.
while read -r pid argv0 argv1 _rest; do
  [[ -z "$pid" || -z "$argv1" ]] && continue

  # argv0 must BE the bun runtime, not merely contain "bun" -- otherwise
  # `/usr/bin/bundler` would qualify.
  [[ "${argv0##*/}" == "bun" ]] || continue

  # argv1 must be the sentinel program. Basename only: the install path varies
  # (~/.bun/bin/sentinel, packages/sentinel/bin/sentinel).
  [[ "${argv1##*/}" == "sentinel" ]] || continue

  printf '%s\n' "$pid"
done

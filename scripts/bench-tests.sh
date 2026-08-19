#!/usr/bin/env bash
#
# bench-tests.sh - time one test-runner configuration under measured contention.
#
# This box runs 5+ agents at once, so a bare wall-clock number is meaningless:
# the same suite takes 90s idle and 6 minutes while two other worktrees are
# running theirs. Every run therefore records HOW BUSY the box was while it ran,
# and the report refuses to compare runs taken under different contention.
#
#   bench-tests.sh <label> [-- <extra runner args>]
#
# Env:
#   BENCH_RUNNER=vitest|bun   which side of the house (default vitest)
#   BENCH_PATHS="a b c"       restrict to these paths (default: whole suite)
#   BENCH_BUDGET=1800         wall-clock kill budget in seconds
#
# Writes .claude/temp/bench/<label>.log (full output, never truncated) and
# appends one row to .claude/temp/bench/results.tsv.
#
# CONTENTION is sampled every 3s as the number of vitest/bun-test processes
# alive system-wide that are NOT ours -- ours all carry `test-perf-bench` in
# their cmdline, so the exclusion is exact rather than a heuristic.

set -uo pipefail

LABEL="${1:?usage: bench-tests.sh <label> [-- <args>]}"
shift
[[ "${1:-}" == "--" ]] && shift

RUNNER="${BENCH_RUNNER:-vitest}"
BUDGET="${BENCH_BUDGET:-1800}"
ROOT="$(git rev-parse --show-toplevel)"
OUT="$ROOT/.claude/temp/bench"
mkdir -p "$OUT"
LOG="$OUT/$LABEL.log"
SAMPLES="$OUT/$LABEL.contention"
RESULTS="$OUT/results.tsv"

: >"$SAMPLES"

# --- contention sampler -----------------------------------------------------
# Counts foreign runner processes + the 1-minute load average. `grep -v` on our
# own worktree name is what makes "foreign" exact; a PID-tree walk would miss
# forks reparented after their runner exits.
(
  while :; do
    foreign=$(ps -Ao command 2>/dev/null |
      grep -E 'node_modules/(\.bin/)?vitest|bun test' |
      grep -v grep | grep -vc 'test-perf-bench')
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    printf '%s\t%s\n' "$foreign" "$load" >>"$SAMPLES"
    sleep 3
  done
) &
SAMPLER=$!
trap 'kill "$SAMPLER" 2>/dev/null' EXIT

# --- the run ----------------------------------------------------------------
# TWO numbers, because on a shared box they answer different questions:
#   wall  = what a waiting human feels; swings wildly with foreign load
#   cpu   = user+sys across the whole process tree = what this config COSTS
#           the fleet. Near-invariant under contention, so it is the metric
#           that can actually rank configs while 5 agents hammer the machine.
# bash's `time` accumulates reaped children, which is exactly the fork pool.
TIMEFORMAT='%R %U %S'
start="$(gdate +%s.%N)"

timing="$( { time {
  if [[ "$RUNNER" == "vitest" ]]; then
    (cd "$ROOT/web" && timeout --foreground --kill-after=30s "$BUDGET" \
      bunx vitest run ${BENCH_PATHS:-} "$@") >"$LOG" 2>&1
  else
    (cd "$ROOT" && timeout --foreground --kill-after=30s "$BUDGET" \
      bun test ${BENCH_PATHS:-} "$@") >"$LOG" 2>&1
  fi
  echo $? >"$OUT/$LABEL.status"
} } 2>&1 )"
status="$(cat "$OUT/$LABEL.status")"
read -r _wall user sys <<<"$timing"
cpu="$(awk -v u="$user" -v s="$sys" 'BEGIN{printf "%.1f", u+s}')"

end="$(gdate +%s.%N)"
kill "$SAMPLER" 2>/dev/null
wall="$(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.1f", b-a}')"

# --- extract ----------------------------------------------------------------
read -r con_mean con_max load_mean <<<"$(
  awk -F'\t' '{c+=$1; if($1>m)m=$1; l+=$2; n++}
       END{if(n)printf "%.1f %d %.0f", c/n, m, l/n; else print "0 0 0"}' "$SAMPLES"
)"

if [[ "$RUNNER" == "vitest" ]]; then
  files="$(grep -oE 'Test Files.*' "$LOG" | tail -1 | tr -s ' ')"
  tests="$(grep -oE '^ *Tests .*' "$LOG" | tail -1 | tr -s ' ')"
  # The phase breakdown is the diagnostic that ranks configs: `environment` is
  # jsdom construction (what isolate:true pays per file), `tests` is the only
  # phase doing real work. A config that cuts wall clock without cutting
  # `environment` just moved the cost around.
  phases="$(grep -oE 'Duration .*' "$LOG" | tail -1 | tr -s ' ')"
  printf '%s\t%s\n' "$LABEL" "$phases" >>"$OUT/phases.tsv"
else
  files="$(grep -oE '[0-9]+ files?' "$LOG" | tail -1)"
  tests="$(grep -cE '^\(pass\)' "$LOG") pass / $(grep -cE '^\(fail\)' "$LOG") fail"
fi

[[ -s "$RESULTS" ]] || printf 'label\trunner\twall_s\tcpu_s\texit\tcontention_mean\tcontention_max\tload_mean\tsummary\n' >"$RESULTS"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s | %s\n' \
  "$LABEL" "$RUNNER" "$wall" "$cpu" "$status" "$con_mean" "$con_max" "$load_mean" "$files" "$tests" >>"$RESULTS"

printf '%-30s wall=%ss cpu=%ss exit=%s foreign=%s/%s load=%s\n' \
  "$LABEL" "$wall" "$cpu" "$status" "$con_mean" "$con_max" "$load_mean"
[[ $status -eq 124 || $status -eq 137 ]] && echo "  ^ KILLED at ${BUDGET}s budget -- hang, not slowness" >&2
exit "$status"

#!/usr/bin/env bash
#
# bench-matrix.sh - run the whole runner-config matrix, interleaved.
#
# INTERLEAVED, not grouped: the box is shared with 4+ other agents whose suites
# start and stop at random, so a grouped run (all reps of A, then all of B)
# hands whichever config ran during a quiet minute an unearned win. Round-robin
# spreads that drift evenly across every config instead.
#
#   bench-matrix.sh [reps]      (default 2)
#
# Every row lands in .claude/temp/bench/results.tsv with its own contention
# figures, so a run taken under a foreign-load spike stays visible as such
# rather than silently poisoning the comparison.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

REPS="${1:-2}"

# label:runner:args -- args are passed verbatim to the runner.
VARIANTS=(
  "v01-forks-isolate-default:vitest:"
  "v02-forks-isolate-max3:vitest:--maxWorkers=3"
  "v03-forks-noisolate-default:vitest:--no-isolate"
  "v04-forks-noisolate-max3:vitest:--no-isolate --maxWorkers=3"
  "v05-threads-isolate-default:vitest:--pool=threads"
  "v06-threads-noisolate-default:vitest:--pool=threads --no-isolate"
)

for rep in $(seq 1 "$REPS"); do
  for v in "${VARIANTS[@]}"; do
    label="${v%%:*}"
    rest="${v#*:}"
    runner="${rest%%:*}"
    args="${rest#*:}"
    echo "--- rep $rep: $label ${args:-(defaults)}"
    # shellcheck disable=SC2086
    BENCH_RUNNER="$runner" ./scripts/bench-tests.sh "${label}-r${rep}" -- $args
  done
done

echo
echo "=== results ==="
column -t -s$'\t' .claude/temp/bench/results.tsv

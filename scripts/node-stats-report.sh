#!/bin/sh
#
# node-stats-report.sh -- the THIRD implementation of the node-stats measurement,
# and the only one that fits on a box you would never install a toolchain on.
#
#   ./node-stats-report.sh --url https://broker.example.com --secret rpt_xxx
#
# It POSTs the same `node_stats` frame the sentinel and the compiled reporter
# send, to the same route, validated by the same broker-side validator. What it
# CANNOT share is the measurement: `sh` cannot import `node-stats-sample.ts`, so
# the arithmetic below is a second reading of the same kernel counters.
#
# THAT IS THE SHARP COST, and it is paid deliberately (card
# `node-stats-http-ingest`, option A -- sanction the script). The contract can
# validate the SHAPE this posts and cannot validate the METHOD, so the METHOD is
# pinned by `scripts/node-stats-report.test.ts`, which runs this script and the
# Bun sampler over identical inputs and fails the build when they disagree.
#
# WHERE THE METHOD IS EASY TO GET WRONG -- all three verified against libuv,
# which is what `os.cpus()` / `os.freemem()` actually read:
#
#   1. CPU total is user+nice+system+idle+irq. iowait, softirq, steal and the
#      guest columns are EXCLUDED. libuv's uv_cpu_info sscanf's six fields and
#      throws iowait away; include it here and this node's cpu% reads lower than
#      every other node on the wall under disk load, for no visible reason.
#   2. Memory free is MemFree, NOT MemAvailable. `freemem()` is sysinfo's
#      freeram, which is MemFree. MemAvailable is the friendlier number and the
#      wrong one: it would make this node look like it had gigabytes the others
#      did not.
#   3. Disk used is total MINUS AVAILABLE, not df's `Used` column. The Bun
#      sampler reads statfs and computes total-bavail, so the root-reserved
#      blocks count as used. df's own Used column excludes them and would report
#      ~5% less on a default ext4.
#
# LINUX ONLY (it reads /proc). On macOS use `bin/node-stats-reporter`, which
# reads the same numbers through libuv. Set NODE_STATS_PROC_ROOT to point the
# reads at a fixture directory -- that is how the conformance test runs anywhere.
#
# POSIX sh. Needs: awk, curl, sha256sum (or shasum), df, uname, hostname.

set -eu

SCRIPT_VERSION="sh-1"
PROC="${NODE_STATS_PROC_ROOT:-/proc}"
URL=""
SECRET=""
INTERVAL=5
MOUNT="/"
ONCE=0
PRINT=0
VERBOSE=0

usage() {
  cat <<'EOF'
Usage: node-stats-report.sh --url <broker-url> --secret <rpt_key> [options]
       node-stats-report.sh cpu-percent <prev-proc-stat> <next-proc-stat>

Options:
  --url URL         Broker base URL, e.g. https://broker.example.com  (or $NODE_STATS_URL)
  --secret KEY      An rpt_ or snt_ secret                            (or $NODE_STATS_SECRET)
  --interval SEC    Sampling cadence in seconds (default 5 -- the shared constant)
  --mount DIR       Volume to measure (default /)
  --once            Send (or print) exactly one frame and exit
  --print           Print the frame to stdout instead of posting it
  --verbose         Log every posted sample
  -h, --help        This

The `cpu-percent` subcommand is the pure arithmetic, over two saved copies of
/proc/stat. It exists so the conformance test can pin the method without racing
a live box.
EOF
}

# ─── The three readings ────────────────────────────────────────────────────

# Cumulative (idle, total) jiffies from a /proc/stat file, using libuv's column
# set. Prints "idle total".
cpu_totals() {
  awk '/^cpu[ \t]/ { print $5, ($2 + $3 + $4 + $5 + $7); exit }' "$1"
}

# Whole-box utilization between two /proc/stat snapshots, 0-100, one decimal.
# Mirrors `cpuPercentFromDelta`: 0 when no time elapsed (never a NaN), clamped,
# and rounded HALF UP like JS `Math.round`, not to-even like printf "%.1f".
cpu_percent_between() {
  # shellcheck disable=SC2046  # word splitting is the mechanism: "idle total" x2
  set -- $(cpu_totals "$1") $(cpu_totals "$2")
  awk -v pi="$1" -v pt="$2" -v ni="$3" -v nt="$4" 'BEGIN {
    td = nt - pt
    if (td <= 0) { print "0"; exit }
    busy = ((td - (ni - pi)) / td) * 100
    if (busy < 0) busy = 0
    if (busy > 100) busy = 100
    r = int(busy * 10 + 0.5) / 10
    printf "%.10g\n", r
  }'
}

# "one five fifteen cores"
load_avg() {
  cores=$(awk '/^processor/ { n++ } END { print (n ? n : 1) }' "$PROC/cpuinfo" 2>/dev/null || echo 1)
  awk -v c="$cores" '{ print $1, $2, $3, c; exit }' "$PROC/loadavg"
}

# "usedBytes totalBytes" -- MemTotal minus MemFree, in bytes.
memory_used_total() {
  awk '/^MemTotal:/ { t = $2 } /^MemFree:/ { f = $2 } END { printf "%.0f %.0f\n", (t - f) * 1024, t * 1024 }' \
    "$PROC/meminfo"
}

# "usedBytes totalBytes" for a volume: total minus AVAILABLE, matching statfs.
disk_used_total() {
  df -Pk "$1" | awk 'NR > 1 { printf "%.0f %.0f\n", ($2 - $4) * 1024, $2 * 1024; exit }'
}

uptime_sec() {
  awk '{ printf "%.0f\n", $1; exit }' "$PROC/uptime"
}

# sha256 of the platform machine id, first 16 hex. MUST match `hostId()` in
# src/shared/host-id.ts or a sentinel and this script on one box become two
# machine rows on the wall, at double the RAM.
host_id() {
  # NOT `[ ... ] && break`: under `set -e` a false test as the last command of a
  # body exits the whole script. Every branch here is an explicit `if`.
  raw=""
  # The darwin branch is here even though this script is Linux-only in
  # production: it is what lets the conformance test compare fingerprints on a
  # mac, and a fingerprint that only matches on the deployment platform is a
  # fingerprint nobody ever checks.
  if [ "$(uname -s)" = "Darwin" ]; then
    raw=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null |
      awk -F'"' '/"IOPlatformUUID"/ { print $4; exit }' || true)
  fi
  if [ -n "$raw" ]; then
    printf '%s' "$raw" | hash_hex
    return
  fi
  for f in /etc/machine-id /var/lib/dbus/machine-id; do
    if [ -r "$f" ]; then
      raw=$(cat "$f")
      if [ -n "$raw" ]; then break; fi
    fi
  done
  if [ -z "$raw" ]; then raw=$(hostname); fi
  printf '%s' "$raw" | hash_hex
}

# sha256 of stdin, first 16 hex chars. `printf` not `echo`, and no trailing
# newline: `createHash().update(str)` hashes the bytes of the string alone, so
# one stray \n here is a different fingerprint and a duplicated host row.
hash_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -c1-16
  else
    shasum -a 256 | cut -c1-16
  fi
}

# `darwin/arm64`, `linux/x64` -- node's spelling, not uname's, so one string
# means one thing whichever sender produced it.
os_arch() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case $(uname -m) in
    x86_64 | amd64) machine="x64" ;;
    aarch64 | arm64) machine="arm64" ;;
    armv7l | armv6l) machine="arm" ;;
    *) machine=$(uname -m) ;;
  esac
  printf '%s/%s' "$os" "$machine"
}

# ─── The frame ─────────────────────────────────────────────────────────────

# build_frame <cpuPercent> -- everything else is read fresh here.
build_frame() {
  cpu="$1"
  # shellcheck disable=SC2046  # each helper prints one space-separated row
  set -- $(load_avg)
  l1="$1" l5="$2" l15="$3" cores="$4"
  # shellcheck disable=SC2046
  set -- $(memory_used_total)
  mem_used="$1" mem_total="$2"
  # shellcheck disable=SC2046
  set -- $(disk_used_total "$MOUNT")
  disk_used="$1" disk_total="$2"

  # `nodeId` is advisory: the broker stamps the id it resolved from the secret.
  # `hostId` is NOT -- it is the machine dedupe key.
  hid=$(host_id)
  printf '{"type":"node_stats",'
  printf '"node":{"nodeId":"sh@%s","hostId":"%s","hostname":"%s","osArch":"%s","agentVersion":"%s","uptimeSec":%s,"sender":"reporter"},' \
    "$hid" "$hid" "$(hostname)" "$(os_arch)" "$SCRIPT_VERSION" "$(uptime_sec)"
  printf '"machine":{"cpuPercent":%s,"load":{"one":%s,"five":%s,"fifteen":%s,"cores":%s},' \
    "$cpu" "$l1" "$l5" "$l15" "$cores"
  printf '"memory":{"usedBytes":%s,"totalBytes":%s},' "$mem_used" "$mem_total"
  printf '"disk":{"usedBytes":%s,"totalBytes":%s,"mount":"%s"}},' "$disk_used" "$disk_total" "$MOUNT"
  printf '"sampledAt":%s000}\n' "$(date +%s)"
}

# The secret rides curl's stdin config, NOT argv: every process on the box can
# read another user's command line out of ps.
post_frame() {
  printf 'header = "Authorization: Bearer %s"\n' "$SECRET" |
    curl --config - -sS -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' --data "$1" "$URL/api/node-stats"
}

# ─── Entry ─────────────────────────────────────────────────────────────────

if [ "${1:-}" = "cpu-percent" ]; then
  [ $# -eq 3 ] || { echo "cpu-percent needs two /proc/stat files" >&2; exit 2; }
  cpu_percent_between "$2" "$3"
  exit 0
fi

URL="${NODE_STATS_URL:-}"
SECRET="${NODE_STATS_SECRET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --mount) MOUNT="$2"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --print) PRINT=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -r "$PROC/stat" ] || {
  echo "node-stats-report.sh: no $PROC/stat -- this reporter is Linux only." >&2
  echo "On macOS use bin/node-stats-reporter (same contract, same numbers)." >&2
  exit 1
}
if [ "$PRINT" -eq 0 ]; then
  [ -n "$URL" ] || { echo "--url is required (or \$NODE_STATS_URL)" >&2; exit 2; }
  [ -n "$SECRET" ] || { echo "--secret is required (or \$NODE_STATS_SECRET)" >&2; exit 2; }
  command -v curl >/dev/null 2>&1 || { echo "curl not found" >&2; exit 1; }
fi

# CPU% is a DELTA, so every frame costs one interval of waiting. The previous
# snapshot lives in a temp file rather than a variable so the same
# `cpu_percent_between` the test pins is the one the loop runs.
WORK=$(mktemp -d)
# shellcheck disable=SC2064  # expand WORK now: the trap must survive its scope
trap "rm -rf '$WORK'" EXIT INT TERM

cp "$PROC/stat" "$WORK/prev"
while :; do
  sleep "$INTERVAL"
  cp "$PROC/stat" "$WORK/next"
  CPU=$(cpu_percent_between "$WORK/prev" "$WORK/next")
  mv "$WORK/next" "$WORK/prev"

  FRAME=$(build_frame "$CPU")
  if [ "$PRINT" -eq 1 ]; then
    printf '%s\n' "$FRAME"
  else
    CODE=$(post_frame "$FRAME" || echo "000")
    # LOG EVERYTHING that is not a 200: a reporter the broker is quietly
    # refusing is the worst failure mode there is.
    if [ "$CODE" != "200" ]; then
      echo "node-stats-report.sh: POST $URL/api/node-stats -> $CODE" >&2
    elif [ "$VERBOSE" -eq 1 ]; then
      echo "node-stats-report.sh: posted cpu=${CPU}%"
    fi
  fi

  if [ "$ONCE" -eq 1 ]; then break; fi
done

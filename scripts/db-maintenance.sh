#!/usr/bin/env bash
# Nightly database maintenance for the broker.
#
# Runs on the HOST (not inside Docker) and drives `broker-cli maintain` through
# docker exec, for the same reason backup-cron.sh does: the container clock is
# UTC, and "05:00" is meant to be 05:00 where Jonas is. Scheduling this host-side
# is what makes the local-time promise true.
#
# Install (AFTER the hourly backup has had time to finish -- the job refuses to
# run without a recent verified backup, which is the entire point):
#   crontab -e
#   5 5 * * * /path/to/scripts/db-maintenance.sh >/dev/null 2>&1
#
# What it does, in order, aborting at the first failure:
#   1. GATE      -- verified backup newer than MAX_BACKUP_AGE minutes
#   2. ARCHIVE   -- export months older than HOT_DAYS to cold NDJSON.zst
#   3. VERIFY    -- re-read each archive and match it against the live database
#   4. DELETE    -- remove archived rows (only when CONFIRM_DELETE=1)
#   5. CHECKPOINT-- wal_checkpoint(TRUNCATE)
#   6. VACUUM    -- reclaim freed pages (skipped when disk headroom is thin)
#   7. SMOKETEST -- quick_check, FTS query, row-count bounds, /health
#
# DELETE IS ON as of 2026-08-19, after six consecutive clean export+verify
# round-trips in the log (2026-04: 33,352 rows, archived and verified against
# the live database every night since 08-14) and with the delete step itself
# never having run once. Set CONFIRM_DELETE=0 to put it back.
#
# What makes this safe is that nothing is deleted that has not first been
# written to a cold NDJSON.zst archive AND verified row-for-row against the
# live database, twice: once in the archive phase and again inside
# pruneArchivedMonth. The delete then runs in a transaction that COUNTs before
# and after and rolls back unless both numbers line up, so a late row landing
# in an already-archived month aborts the delete instead of being destroyed.
#
# Env overrides:
#   BROKER_CONTAINER   default: broker
#   HOT_DAYS           default: 90
#   MAX_BACKUP_AGE     default: 90 (minutes)
#   CONFIRM_DELETE     default: 1
#   DRY_RUN            default: 0
#   CLAUDEWERK_LOG_DIR default: ~/Library/Logs/claudewerk

set -euo pipefail

CONTAINER="${BROKER_CONTAINER:-broker}"
HOT_DAYS="${HOT_DAYS:-90}"
MAX_BACKUP_AGE="${MAX_BACKUP_AGE:-90}"
CONFIRM_DELETE="${CONFIRM_DELETE:-1}"
DRY_RUN="${DRY_RUN:-0}"

LOG_DIR="${CLAUDEWERK_LOG_DIR:-$HOME/Library/Logs/claudewerk}"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/db-maintenance.log") 2>&1

echo "--- $(date -Iseconds) maintenance start (hot_days=$HOT_DAYS confirm_delete=$CONFIRM_DELETE dry_run=$DRY_RUN) ---"

# cron's PATH is /usr/bin:/bin and docker is in none of the usual places.
# backup-cron.sh learned this the hard way (every run died for a month).
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/.orbstack/bin:$PATH"
DOCKER="${DOCKER_BIN:-$(command -v docker || true)}"
if [[ -z "$DOCKER" ]]; then
  echo "FATAL: 'docker' not found on PATH ($PATH). Set DOCKER_BIN to its absolute path." >&2
  exit 2
fi

if ! "$DOCKER" ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running (docker=$DOCKER)" >&2
  exit 1
fi

ARGS=(maintain --hot-days "$HOT_DAYS" --max-backup-age "$MAX_BACKUP_AGE" --health-url "http://localhost:9999/health")
[[ "$CONFIRM_DELETE" == "1" ]] && ARGS+=(--confirm)
[[ "$DRY_RUN" == "1" ]] && ARGS+=(--dry-run)

set +e
"$DOCKER" exec "$CONTAINER" broker-cli "${ARGS[@]}"
STATUS=$?
set -e

echo "--- $(date -Iseconds) maintenance done (exit=$STATUS) ---"

# Non-zero exit is deliberate: a failed nightly run should be visible to
# whatever wraps this, not swallowed into a log nobody reads.
exit "$STATUS"

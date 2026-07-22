#!/usr/bin/env bash
# Hourly backup cron for the broker container.
#
# Runs inside the host (not inside Docker). Executes broker-cli backup
# inside the running container, with tiered retention:
#   - All backups from the last 24 hours (hourly granularity)
#   - 1 per day for the last 7 days (daily granularity)
#
# Install:
#   crontab -e
#   0 * * * * /path/to/scripts/backup-cron.sh
#
# The script writes its own persistent log to
# ~/Library/Logs/claudewerk/backup.log (override with CLAUDEWERK_LOG_DIR), so a
# missing/rotated crontab redirect can no longer hide failures. A crontab
# redirect is still fine but no longer required.
#
# Override container name via BROKER_CONTAINER env var (default: broker).
# Override the docker binary via DOCKER_BIN if it lives somewhere exotic.

set -euo pipefail

CONTAINER="${BROKER_CONTAINER:-broker}"
DEST="/data/backups"
RETAIN_HOURS=24
RETAIN_DAYS=7

# --- persistent logging -----------------------------------------------------
# cron runs with a minimal PATH and no redirect guarantees. Log to a real file
# we control so failures are never silent again (the 2026-06-22 incident: cron
# could not find `docker`, every run died for a month with nobody watching).
LOG_DIR="${CLAUDEWERK_LOG_DIR:-$HOME/Library/Logs/claudewerk}"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/backup.log") 2>&1

echo "--- $(date -Iseconds) backup start ---"

# --- resolve docker (cron PATH is minimal: /usr/bin:/bin) -------------------
# This is the bug that silently killed backups for a month: `docker` lives in
# /usr/local/bin (Docker Desktop) or /opt/homebrew/bin, neither on cron's PATH.
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

"$DOCKER" exec "$CONTAINER" broker-cli backup create \
  --dest "$DEST" \
  --retain-hours "$RETAIN_HOURS" \
  --retain-days "$RETAIN_DAYS"

echo "--- $(date -Iseconds) backup done ---"

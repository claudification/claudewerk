#!/usr/bin/env bash
# Backup + disk watchdog for the broker.
#
# Deliberately DOCKER-FREE and container-free: it inspects the real backup
# archives on the host bind-mount and the host filesystem directly, so it still
# reports correctly when the broker (or docker itself) is down -- which is
# exactly when you most want to know the backups stopped.
#
# Writes a machine-readable health file and a human log; emits nothing to any
# push channel (by design). Grep the health file or tail the log to check.
#   health: ~/Library/Logs/claudewerk/backup-health.json
#   log:    ~/Library/Logs/claudewerk/backup-monitor.log
#
# Install (offset from the backup cron so it reads a settled state):
#   30 * * * * /path/to/scripts/backup-monitor.sh
#
# Env overrides:
#   BACKUP_DIR      host path holding backup-*.tar.gz (default: repo ./backups)
#   STALE_HOURS     newest backup older than this -> STALE  (default: 3)
#   DISK_WARN_PCT   filesystem used% at/above this -> DISK_WARN (default: 90)
#   CLAUDEWERK_LOG_DIR  where health+log are written

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
STALE_HOURS="${STALE_HOURS:-3}"
DISK_WARN_PCT="${DISK_WARN_PCT:-90}"

LOG_DIR="${CLAUDEWERK_LOG_DIR:-$HOME/Library/Logs/claudewerk}"
mkdir -p "$LOG_DIR"
HEALTH_FILE="$LOG_DIR/backup-health.json"
LOG_FILE="$LOG_DIR/backup-monitor.log"

now_epoch=$(date +%s)
checked_at=$(date -Iseconds)

# --- newest backup archive --------------------------------------------------
newest=""
newest_epoch=0
if [[ -d "$BACKUP_DIR" ]]; then
  # -f%m = mtime epoch on BSD/macOS stat.
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    m=$(stat -f%m "$f" 2>/dev/null || echo 0)
    if (( m > newest_epoch )); then newest_epoch=$m; newest="$f"; fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.tar.gz' 2>/dev/null)
fi

if (( newest_epoch == 0 )); then
  backup_status="MISSING"
  age_hours="null"
  newest_name="null"
else
  age_sec=$(( now_epoch - newest_epoch ))
  age_hours=$(( age_sec / 3600 ))
  newest_name="\"$(basename "$newest")\""
  if (( age_sec > STALE_HOURS * 3600 )); then
    backup_status="STALE"
  else
    backup_status="OK"
  fi
fi

# --- filesystem headroom ----------------------------------------------------
# df -P: portable columns; capacity is col5 like "98%".
read -r disk_used_pct disk_avail < <(df -P "$BACKUP_DIR" | awk 'NR==2 {gsub("%","",$5); print $5, $4}')
if (( disk_used_pct >= DISK_WARN_PCT )); then
  disk_status="DISK_WARN"
else
  disk_status="OK"
fi

# --- overall verdict --------------------------------------------------------
if [[ "$backup_status" == "OK" && "$disk_status" == "OK" ]]; then
  overall="OK"
else
  overall="ATTENTION"
fi

age_field=${age_hours:-null}
cat > "$HEALTH_FILE" <<JSON
{
  "checked_at": "$checked_at",
  "overall": "$overall",
  "backup_status": "$backup_status",
  "newest_backup": $newest_name,
  "newest_age_hours": $age_field,
  "stale_threshold_hours": $STALE_HOURS,
  "disk_status": "$disk_status",
  "disk_used_pct": $disk_used_pct,
  "disk_avail": "$disk_avail",
  "disk_warn_pct": $DISK_WARN_PCT,
  "backup_dir": "$BACKUP_DIR"
}
JSON

line="$checked_at overall=$overall backup=$backup_status newest=${newest_name//\"/} age_h=$age_field disk=${disk_used_pct}%(${disk_status}) avail=$disk_avail"
echo "$line" | tee -a "$LOG_FILE" >&2

# Non-zero exit on trouble so a future alert wiring (or a human running it) sees
# the failure without parsing. Stays file+log-only until someone opts into push.
[[ "$overall" == "OK" ]]

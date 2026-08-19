#!/usr/bin/env bash
#
# Install the node-stats-reporter as a systemd service.
#
# Run ON THE TARGET BOX, as a user with sudo. The binary and the unit file are
# expected to already be in the same directory as this script (scp them across
# first, or use deploy.sh from the workstation which does both).
#
#   ./install.sh --broker wss://concentrator.frst.dev --secret rpt_... [--disk /]
#
# The secret is written to /etc/node-stats-reporter/env at 0600, root-owned. It
# is never passed on the command line to the service itself, because argv is
# visible to every process on the box via `ps`.
#
# Idempotent: re-running upgrades the binary and restarts the service.

set -euo pipefail

BROKER=""
SECRET=""
DISK="/"

while [ $# -gt 0 ]; do
  case "$1" in
    --broker) BROKER="${2:-}"; shift 2 ;;
    --secret) SECRET="${2:-}"; shift 2 ;;
    --disk)   DISK="${2:-}";   shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$BROKER" ] || { echo "ERROR: --broker is required" >&2; exit 1; }
[ -n "$SECRET" ] || { echo "ERROR: --secret is required" >&2; exit 1; }

case "$SECRET" in
  rpt_*) ;;
  # Refuse an snt_ or admin secret outright: this box is being given a reporter
  # precisely so it does NOT hold spawn authority.
  *) echo "ERROR: secret must be a reporter key (rpt_ prefix). Refusing." >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
BINARY="$HERE/node-stats-reporter"
UNIT="$HERE/node-stats-reporter.service"

[ -f "$BINARY" ] || { echo "ERROR: $BINARY not found (scp it here first)" >&2; exit 1; }
[ -f "$UNIT" ]   || { echo "ERROR: $UNIT not found" >&2; exit 1; }

echo "==> Installing binary to /usr/local/bin/node-stats-reporter"
sudo install -m 0755 -o root -g root "$BINARY" /usr/local/bin/node-stats-reporter

echo "==> Writing /etc/node-stats-reporter/env (0600, root-owned)"
sudo mkdir -p /etc/node-stats-reporter
sudo chmod 0700 /etc/node-stats-reporter

# Staged through a 0600 temp file and placed with `install`, NOT piped through
# `sudo sh -c`. Two reasons:
#   1. `install` sets owner+mode as it writes, so the secret is never even
#      briefly readable at the destination.
#   2. a hardened sudoers may deny `sudo sh` outright (Synology DSM does exactly
#      that: `NOPASSWD: ALL, !/bin/sh, !/bin/bash, !/bin/ash, !/usr/bin/su`).
umask 077
ENV_TMP="$(mktemp)"
trap 'rm -f "$ENV_TMP"' EXIT INT TERM
cat > "$ENV_TMP" <<EOF
CLAUDWERK_BROKER=$BROKER
CLAUDWERK_REPORTER_SECRET=$SECRET
REPORTER_DISK=$DISK
EOF
sudo install -m 0600 -o root -g root "$ENV_TMP" /etc/node-stats-reporter/env
rm -f "$ENV_TMP"
trap - EXIT INT TERM

echo "==> Installing systemd unit"
sudo install -m 0644 -o root -g root "$UNIT" /etc/systemd/system/node-stats-reporter.service

echo "==> Enabling + starting"
sudo systemctl daemon-reload
sudo systemctl enable node-stats-reporter.service >/dev/null 2>&1 || true
sudo systemctl restart node-stats-reporter.service

sleep 3
echo
echo "==> Status"
sudo systemctl is-active node-stats-reporter.service || true
sudo journalctl -u node-stats-reporter.service -n 15 --no-pager 2>/dev/null || true

echo
echo "Done. Follow it with:  sudo journalctl -u node-stats-reporter -f"

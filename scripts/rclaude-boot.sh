#!/usr/bin/env bash
#
# rclaude-boot.sh - Smart launcher for rclaude in tmux
#
# Tries --continue first (resume existing session). If that fails
# (no session to continue), starts fresh without --continue.
#
# Usage: rclaude-boot.sh [rclaude args...]
#   e.g. rclaude-boot.sh --dangerously-skip-permissions
#

ARGS=("$@")

# Try --continue first
rclaude "${ARGS[@]}" --continue
EXIT_CODE=$?

# If --continue failed (exit code != 0 within 5 seconds = no session to continue),
# start fresh. If it ran for a while and then exited, don't retry - that's a real exit.
if [[ $EXIT_CODE -ne 0 ]]; then
  exec rclaude "${ARGS[@]}"
fi

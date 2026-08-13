#!/usr/bin/env bash
# Generate the STT lag probe's audio fixture: ~27s of technical speech as 16kHz
# mono linear16, the exact format every provider in stt-providers.ts is fed.
#
# NOT committed (858KB of binary that regenerates in two seconds). The probe
# calls this automatically when the fixture is missing.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)/stt-probe.raw"
tmp="$(mktemp -t stt-probe).aiff"
trap 'rm -f "$tmp"' EXIT

command -v ffmpeg >/dev/null || { echo "need ffmpeg (brew install ffmpeg)" >&2; exit 1; }
command -v say >/dev/null || { echo "need macOS 'say' -- supply your own 16kHz mono s16le at $out" >&2; exit 1; }

# Deliberately full of this project's vocabulary: broker, sentinel, agent host.
# Domain nouns are where ASR engines actually differ, so a generic passage would
# hide the difference the probe exists to measure.
say -v Daniel -o "$tmp" "Okay so I want to add a new endpoint to the broker that handles authorization \
and permissions, and it should use JSON web tokens for the token format. The sentinel spawns the agent \
host, and the control panel renders the transcript. Deepgram nova three is the current speech recognition \
model, but we are evaluating Cloudflare Workers AI as an alternative because the round trip from Thailand \
to the United States is roughly two hundred and seventy milliseconds."

ffmpeg -y -loglevel error -i "$tmp" -ar 16000 -ac 1 -f s16le "$out"
echo "wrote $out ($(( $(stat -f %z "$out" 2>/dev/null || stat -c %s "$out") / 32000 ))s of 16kHz mono PCM)"

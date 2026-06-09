/**
 * Host-agnostic helpers for Claude Code's on-disk transcript naming
 * (`<configDir>/projects/<slug>/<ccSessionId>.jsonl`).
 *
 * Lives in `src/shared/` because more than one host needs the
 * filename <-> ccSessionId mapping: the daemon host's session observer
 * (live JSONL discovery) and the claude host's history import (batch
 * backfill). The daemon-specific path *construction* (slugging, realpath,
 * profile config dirs) stays in `src/daemon-agent-host/transcript-path.ts`.
 */

/**
 * The `ccSessionId` encoded in a transcript JSONL file name, or `null` if the
 * name is not a `<id>.jsonl`. The id IS the file's base name -- a CC session's
 * ccSessionId is exactly the name of the JSONL it writes.
 */
export function ccSessionIdFromJsonl(fileName: string): string | null {
  if (!fileName.endsWith('.jsonl')) return null
  const id = fileName.slice(0, -'.jsonl'.length)
  return id.length > 0 ? id : null
}

/**
 * Whether a transcript file is a sub-agent (Task-tool sidechain) transcript.
 * CC writes those as `agent-<hex>.jsonl` next to the parent session's JSONL;
 * every entry inside carries `isSidechain: true`.
 */
export function isAgentTranscriptFile(fileName: string): boolean {
  return fileName.startsWith('agent-') && fileName.endsWith('.jsonl')
}

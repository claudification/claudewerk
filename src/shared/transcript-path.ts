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
 * CC's `<configDir>/projects/<slug>` directory name for a cwd: every '/', '.'
 * and '_' becomes '-'.
 *
 * All three characters matter. Slugging only '/' leaves the dot in
 * `.claude/worktrees/...` intact, which points at a directory CC never creates
 * -- so transcript discovery came back empty for every worktree conversation.
 * Callers that have a real on-disk path should resolve symlinks BEFORE calling
 * (CC slugs the resolved path; on macOS `/var/...` is really `/private/var/...`).
 */
export function transcriptSlug(cwd: string): string {
  return cwd.replace(/[/._]/g, '-')
}

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

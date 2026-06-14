/**
 * transcript-path -- where a Claude Code daemon worker writes its transcript.
 *
 * CC stores every session transcript at
 *   <configDir>/projects/<slug>/<ccSessionId>.jsonl
 * where <slug> is the worker cwd with every '/', '.' and '_' replaced by '-'
 * and <configDir> is `CLAUDE_CONFIG_DIR` (default `~/.claude`).
 *
 * THE SLUG IS DERIVED FROM THE REAL PATH (symlinks resolved). On macOS a cwd
 * under /var/folders/... resolves to /private/var/folders/... because /var is
 * a symlink -- CC slugs the resolved path, so deriving the slug from the raw
 * cwd misses the JSONL entirely whenever cwd has a symlinked component. This
 * was a live bug found by the Phase A E2E (commit f6b23bea).
 *
 * THE CONFIG DIR FOLLOWS THE PROFILE. When the sentinel injects a sentinel
 * profile (see `.claude/docs/plan-sentinel-profiles.md`), it sets
 * `CLAUDE_CONFIG_DIR` on the agent-host process; `claudeConfigDir()` returns
 * that value here so transcript discovery lands in the same dir CC is
 * actually writing to.
 *
 * Both the transcript bridge (watches one JSONL) and the session observer
 * (watches the project dir for /clear rotations) need these paths, so they
 * live here rather than being re-derived in each.
 */

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { claudeConfigDir } from '../shared/claude-config-dir'

/** The `<configDir>/projects/<slug>` directory for a worker `cwd`. */
export function transcriptProjectDir(cwd: string): string {
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd does not exist on this host -- fall back to the path as given.
  }
  const slug = realCwd.replace(/[/._]/g, '-')
  return join(claudeConfigDir(), 'projects', slug)
}

/** The JSONL transcript path for a `(cwd, ccSessionId)` pair. */
export function transcriptJsonlPath(cwd: string, ccSessionId: string): string {
  return join(transcriptProjectDir(cwd), `${ccSessionId}.jsonl`)
}

// ccSessionIdFromJsonl moved to src/shared/transcript-path.ts (the history
// import needs the filename <-> id mapping too); re-exported so existing
// daemon-side imports keep working unchanged.
export { ccSessionIdFromJsonl } from '../shared/transcript-path'

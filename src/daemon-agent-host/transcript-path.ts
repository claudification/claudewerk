/**
 * transcript-path -- where a Claude Code daemon worker writes its transcript.
 *
 * CC stores every session transcript at
 *   ~/.claude/projects/<slug>/<ccSessionId>.jsonl
 * where <slug> is the worker cwd with every '/', '.' and '_' replaced by '-'.
 *
 * THE SLUG IS DERIVED FROM THE REAL PATH (symlinks resolved). On macOS a cwd
 * under /var/folders/... resolves to /private/var/folders/... because /var is
 * a symlink -- CC slugs the resolved path, so deriving the slug from the raw
 * cwd misses the JSONL entirely whenever cwd has a symlinked component. This
 * was a live bug found by the Phase A E2E (commit f6b23bea).
 *
 * Both the transcript bridge (watches one JSONL) and the session observer
 * (watches the project dir for /clear rotations) need these paths, so they
 * live here rather than being re-derived in each.
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The `~/.claude/projects/<slug>` directory for a worker `cwd`. */
export function transcriptProjectDir(cwd: string): string {
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd does not exist on this host -- fall back to the path as given.
  }
  const slug = realCwd.replace(/[/._]/g, '-')
  return join(homedir(), '.claude', 'projects', slug)
}

/** The JSONL transcript path for a `(cwd, ccSessionId)` pair. */
export function transcriptJsonlPath(cwd: string, ccSessionId: string): string {
  return join(transcriptProjectDir(cwd), `${ccSessionId}.jsonl`)
}

/**
 * The `ccSessionId` encoded in a transcript JSONL file name, or `null` if the
 * name is not a `<id>.jsonl`. The id IS the file's base name -- a daemon
 * worker's live ccSessionId is exactly the name of the JSONL it is writing.
 */
export function ccSessionIdFromJsonl(fileName: string): string | null {
  if (!fileName.endsWith('.jsonl')) return null
  const id = fileName.slice(0, -'.jsonl'.length)
  return id.length > 0 ? id : null
}

/**
 * Sentinel-side git log gathering for project recaps. The broker asks (via the
 * `git_log_request` RPC) for commits in a directory over a period; the sentinel
 * owns the host filesystem, runs `git log`, and returns the parsed result.
 *
 * The pretty-format uses ASCII control bytes as separators so commit content
 * (which may contain commas, newlines, pipes) never collides with delimiters:
 *   0x1e (RS) starts each commit record
 *   0x1f (US) separates header fields
 *   0x1d (GS) terminates the header (before the --numstat block)
 */

import type { GitLogCommit } from '../shared/protocol'

const RS = '\x1e'
const US = '\x1f'
const GS = '\x1d'
const PRETTY = `--pretty=format:${RS}%H${US}%aI${US}%an${US}%s${US}%b${GS}`
const MAX_COMMITS = 500

export interface GitLogOutcome {
  commits: GitLogCommit[]
  error?: string
}

/** Run `git log` in `cwd` for [sinceMs, untilMs]. Pure I/O wrapper around the
 *  parser below. Never throws -- returns `{ commits: [], error }` on failure. */
// fallow-ignore-next-line complexity
export function runGitLog(cwd: string, sinceMs: number, untilMs: number): GitLogOutcome {
  if (!cwd) return { commits: [], error: 'no cwd' }
  const since = new Date(sinceMs).toISOString()
  const until = new Date(untilMs).toISOString()
  try {
    const proc = Bun.spawnSync(
      [
        'git',
        '-C',
        cwd,
        'log',
        '--no-color',
        `--max-count=${MAX_COMMITS}`,
        `--since=${since}`,
        `--until=${until}`,
        '--numstat',
        '--date=iso-strict',
        PRETTY,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : ''
      return { commits: [], error: stderr || `git exited ${proc.exitCode}` }
    }
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : ''
    return { commits: parseGitLogOutput(stdout) }
  } catch (err) {
    return { commits: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** Parse the RS/US/GS-delimited `git log --numstat` output into commits.
 *  Exported for unit testing without a real git repo. */
// fallow-ignore-next-line complexity
export function parseGitLogOutput(stdout: string): GitLogCommit[] {
  const commits: GitLogCommit[] = []
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue
    const gsIdx = record.indexOf(GS)
    if (gsIdx === -1) continue
    const header = record.slice(0, gsIdx)
    const numstatBlock = record.slice(gsIdx + 1)
    const [sha, isoDate, author, subject, ...bodyParts] = header.split(US)
    if (!sha) continue
    const { filesChanged, insertions, deletions } = sumNumstat(numstatBlock)
    commits.push({
      sha,
      isoDate: isoDate ?? '',
      author: author ?? '',
      subject: subject ?? '',
      body: (bodyParts.join(US) ?? '').trim(),
      filesChanged,
      insertions,
      deletions,
    })
  }
  return commits
}

// fallow-ignore-next-line complexity
function sumNumstat(block: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue
    filesChanged++
    // Binary files report '-' for both counts; treat as 0.
    const ins = Number.parseInt(parts[0], 10)
    const del = Number.parseInt(parts[1], 10)
    if (Number.isFinite(ins)) insertions += ins
    if (Number.isFinite(del)) deletions += del
  }
  return { filesChanged, insertions, deletions }
}

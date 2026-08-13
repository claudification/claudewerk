/**
 * Every tracked shell script must be executable IN THE GIT INDEX.
 *
 * The incident (2026-08-14): `scripts/db-maintenance.sh` was committed mode
 * 100644. Its crontab entry runs it directly --
 *
 *   5 5 * * * /path/to/scripts/db-maintenance.sh >/dev/null 2>&1
 *
 * -- so cron got EACCES, and because both streams go to /dev/null the failure
 * was completely silent. The nightly archive+reclaim job had never executed
 * once. `store.db` reached 10.07 GB and only a single month had ever been
 * exported to cold storage. The maintenance report blamed `CONFIRM_DELETE=0`,
 * which was never even the first blocker.
 *
 * This asserts the GIT INDEX mode, not the filesystem bit, and that distinction
 * is the whole point: a fresh clone takes its mode from git. Someone can
 * `chmod +x` locally, watch it work, commit, and ship a file that is still 644
 * for everybody else -- including CI and a redeployed host.
 */

import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** Scripts that are legitimately non-executable, each with the reason why.
 *  An entry here is a claim that something ELSE grants the bit -- verify it
 *  before adding one. */
const EXEMPT: Record<string, string> = {
  'docker/runner-entrypoint.sh': 'Dockerfile.runner:82 runs `chmod +x` on it after COPY',
}

function trackedShellScripts(): { mode: string; path: string }[] {
  const out = Bun.spawnSync(['git', 'ls-files', '-s', '*.sh'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`)

  return out.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      // "<mode> <sha> <stage>\t<path>"
      const [meta, path] = line.split('\t')
      return { mode: meta.split(' ')[0], path }
    })
}

describe('tracked shell scripts', () => {
  const scripts = trackedShellScripts()

  it('finds shell scripts to check (guards against a silently empty sweep)', () => {
    expect(scripts.length).toBeGreaterThan(10)
  })

  it.each(
    scripts.filter(s => !(s.path in EXEMPT)).map(s => [s.path, s.mode]),
  )('%s is executable in the git index', (path, mode) => {
    expect(
      mode,
      `${path} is ${mode} in the git index -- cron/exec will fail with EACCES. Fix with: git update-index --chmod=+x ${path}`,
    ).toBe('100755')
  })

  it('every exemption still names a script that exists', () => {
    const tracked = new Set(scripts.map(s => s.path))
    for (const path of Object.keys(EXEMPT)) {
      expect(tracked.has(path), `${path} is exempted but no longer tracked -- drop the exemption`).toBe(true)
    }
  })
})

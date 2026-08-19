/**
 * The stable per-HOST fingerprint, shared by every agent on the box.
 *
 * This MUST be one implementation. A sentinel and a standalone reporter running
 * on the same machine only collapse into one machine row if they compute the
 * same `hostId` -- two fingerprint algorithms would put one box on the wall
 * twice, at double the RAM, which is precisely the double-counting the
 * node-stats contract exists to prevent. So it lives here rather than inside
 * the sentinel, where the reporter cannot reach it.
 *
 * The algorithm is unchanged from the sentinel's original `getMachineId`:
 * sha256 of the platform's machine identifier, first 16 hex chars. Changing it
 * would re-key every existing sentinel, so don't.
 *
 * `node:child_process` rather than `Bun.spawnSync`: `web/tsconfig.json`
 * typechecks all of `src/shared` with no Bun globals. This runs ONCE at startup
 * (not on the sampling tick), so the fork is not a cost that matters here.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * The platform's raw machine identifier. Falls back to the hostname when the
 * platform has no stable id -- worse (a rename re-keys the host) but never
 * empty, and a wrong-but-consistent key still dedupes correctly within a run.
 */
export function rawHostId(): string {
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match) return match[1]
    } catch {}
  }

  if (process.platform === 'linux') {
    // /etc/machine-id is the systemd standard; dbus keeps a copy on older boxes.
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(path, 'utf8').trim()
        if (id) return id
      } catch {}
    }
  }

  return hostname()
}

/** Hashed host fingerprint. Hashed so a raw hardware UUID never travels. */
export function hostId(): string {
  return createHash('sha256').update(rawHostId()).digest('hex').slice(0, 16)
}

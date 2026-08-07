/** Refuse to write cold archives onto ephemeral container storage.
 *
 *  `/data/archives` was NOT a mount. It sat in the broker container's writable
 *  layer, which `docker compose up -d` throws away on every deploy. Cold
 *  archives are the ONLY copy of a month once retention deletes it from the hot
 *  database and they are not inside the hourly backup tar, so a routine redeploy
 *  would have silently destroyed history that nothing else held.
 *
 *  The archive directory must therefore live on its own mount -- a bind mount or
 *  a named volume. A directory whose nearest mount point is `/` is the overlay
 *  root, i.e. the disposable layer.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MOUNTINFO = '/proc/self/mountinfo'

/** Mount points from mountinfo (field 5, space-separated, octal-escaped). */
export function parseMountPoints(mountinfo: string): string[] {
  return mountinfo
    .split('\n')
    .map(line => line.split(' ')[4])
    .filter((p): p is string => Boolean(p))
    .map(p => p.replaceAll('\\040', ' '))
}

/** True when `dir` sits on a mount of its own rather than on the container's
 *  root filesystem. The nearest enclosing mount point wins, so
 *  `/data/archives/2026` counts as persistent when `/data/archives` is bound. */
export function isPersistentDir(dir: string, mountPoints: string[]): boolean {
  const target = resolve(dir)
  let nearest = ''
  for (const point of mountPoints) {
    const covers = target === point || target.startsWith(point.endsWith('/') ? point : `${point}/`)
    if (covers && point.length > nearest.length) nearest = point
  }
  return nearest !== '' && nearest !== '/'
}

function readMountPoints(): string[] | null {
  try {
    return parseMountPoints(readFileSync(MOUNTINFO, 'utf-8'))
  } catch {
    // No procfs: a Mac dev box or a plain test run, where there is no
    // disposable overlay to protect against.
    return null
  }
}

/** Throw unless `dir` will survive a container recreate.
 *
 *  `CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES=1` opts out for a throwaway broker.
 *  `points` is injectable so the container's layout can be asserted from a dev
 *  box that has no procfs of its own. */
export function assertDurableArchiveDir(dir: string, points?: string[]): void {
  if (process.env.CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES === '1') return
  const mountPoints = points ?? readMountPoints()
  if (mountPoints === null) return
  if (isPersistentDir(dir, mountPoints)) return
  throw new Error(
    `archive dir ${dir} is on the container's writable layer -- a redeploy would destroy it. ` +
      'Bind-mount it (see the ARCHIVE_DIR volume in docker-compose.yml), ' +
      'or set CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES=1 if this broker is disposable.',
  )
}

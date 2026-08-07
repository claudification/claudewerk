import { expect, test } from 'bun:test'
import { assertDurableArchiveDir, isPersistentDir, parseMountPoints } from '../durable'

// A trimmed real mountinfo from the broker container: overlay root, the
// concentrator-data volume on /data/cache, the backups bind on /data/backups.
// /data/archives is conspicuously absent -- that WAS the bug.
const MOUNTINFO = [
  '580 493 0:96 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/AAA',
  '581 580 0:99 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
  '600 580 0:88 /_data /data/cache rw,relatime - ext4 /dev/vda1 rw',
  '601 580 0:88 /backups /data/backups rw,relatime - ext4 /dev/vda1 rw',
].join('\n')

test('parseMountPoints reads the mount-point field', () => {
  expect(parseMountPoints(MOUNTINFO)).toEqual(['/', '/proc', '/data/cache', '/data/backups'])
})

test('parseMountPoints unescapes a space in a mount point', () => {
  expect(parseMountPoints('1 2 0:1 / /mnt/my\\040disk rw - ext4 /dev/x rw')).toEqual(['/mnt/my disk'])
})

// REGRESSION -- /data/archives lived in the container's writable layer, so every
// `docker compose up -d` deleted every cold archive. Cold archives are the only
// copy of a month once retention drops it from the hot database, and they are
// not inside the backup tar, so a routine redeploy would have destroyed history
// nothing else held.
test('the container writable layer is not a durable archive dir', () => {
  const points = parseMountPoints(MOUNTINFO)
  expect(isPersistentDir('/data/archives', points)).toBe(false)
  expect(() => assertDurableArchiveDir('/data/archives', points)).toThrow(/writable layer/)
})

test('the bind-mounted archive dir passes the same guard', () => {
  // What the fixed docker-compose gives us: ${ARCHIVE_DIR:-./archives} bound in.
  const points = [...parseMountPoints(MOUNTINFO), '/data/archives']
  expect(() => assertDurableArchiveDir('/data/archives', points)).not.toThrow()
})

test('a bind-mounted dir and its subdirectories are durable', () => {
  const points = parseMountPoints(MOUNTINFO)
  expect(isPersistentDir('/data/backups', points)).toBe(true)
  expect(isPersistentDir('/data/backups/archives/2026', points)).toBe(true)
  expect(isPersistentDir('/data/cache', points)).toBe(true)
})

test('a sibling with a shared prefix does not borrow the mount', () => {
  // /data/cache-scratch must NOT count as covered by /data/cache.
  expect(isPersistentDir('/data/cache-scratch', parseMountPoints(MOUNTINFO))).toBe(false)
})

test('the escape hatch opts a disposable broker out', () => {
  process.env.CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES = '1'
  try {
    expect(() => assertDurableArchiveDir('/data/archives', parseMountPoints(MOUNTINFO))).not.toThrow()
  } finally {
    delete process.env.CLAUDWERK_ALLOW_EPHEMERAL_ARCHIVES
  }
})

test('no procfs means no overlay to protect against', () => {
  // A Mac dev box has no /proc/self/mountinfo; the check must not fire there.
  expect(() => assertDurableArchiveDir('/tmp/whatever')).not.toThrow()
})

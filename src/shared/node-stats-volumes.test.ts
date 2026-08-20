/**
 * The per-volume collector: what it reports, and -- mostly -- what it refuses to.
 *
 * The fixture below is a REAL `df -Pk` capture from `studio` (2026-08-20,
 * trimmed of nothing that matters), because every hard case here is a case that
 * box actually produces: five APFS volumes sharing one container and reporting
 * one free-space figure between them, hourly TimeMachine snapshot mounts whose
 * path carries a timestamp, read-only simulator images pinned at 98% forever.
 */

import { describe, expect, it } from 'bun:test'
import {
  EPHEMERAL_MOUNT_PREFIXES,
  isReportableMount,
  PSEUDO_MOUNT_PREFIXES,
  parseDfMounts,
  readVolumes,
  resetVolumeMountCache,
  selectVolumes,
  VOLUME_MOUNT_REFRESH_MS,
} from './node-stats-volumes'

/** `df -Pk` on studio, 2026-08-20. */
const STUDIO = [
  'Filesystem                     1024-blocks        Used  Available Capacity  Mounted on',
  '/dev/disk3s1s1                  1948455240    12275032  282123420     5%    /',
  'devfs                                  252         252          0   100%    /dev',
  '/dev/disk3s6                    1948455240    17827424  282123420     6%    /System/Volumes/VM',
  '/dev/disk3s2                    1948455240     8846312  282123420     4%    /System/Volumes/Preboot',
  '/dev/disk3s4                    1948455240        8224  282123420     1%    /System/Volumes/Update',
  '/dev/disk3s5                    1948455240  1625818500  282123420    86%    /System/Volumes/Data',
  'map auto_home                            0           0          0   100%    /System/Volumes/Data/home',
  '/dev/disk5s1                    7813821400   869140320 6943845244    12%    /Volumes/Fint',
  '/dev/disk7s1                      17639424    17136884     457296    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23E244',
  '//jonas@store/downloads         6442450944  6440859136    1591808   100%    /Volumes/downloads',
  '/dev/disk19s2                   2927734376  1671036996 1256697380    58%    /Volumes/Stuff 1',
  'com.apple.TimeMachine.2026-08-20-193107.local@/dev/disk3s5 1948455240 1625658956 282123400 86% /Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/Mac Studio/2026-08-20-193107/Data',
].join('\n')

const KB = 1024

function mounts(volumes: Array<{ mount: string }>): string[] {
  return volumes.map(v => v.mount)
}

describe('parseDfMounts -- the whole table, not one row', () => {
  it('reads every filesystem df listed, header excluded', () => {
    // 12 data lines, minus `map auto_home`, which reports no blocks at all --
    // `usedFromAvailable` refuses to call 0/0 a disk. The parser does no other
    // filtering; deciding what deserves a series is `selectVolumes`'s job.
    expect(parseDfMounts(STUDIO)).toHaveLength(11)
    expect(mounts(parseDfMounts(STUDIO))).toContain('/Volumes/Fint')
    expect(mounts(parseDfMounts(STUDIO))).not.toContain('/System/Volumes/Data/home')
  })

  it('computes used the ONE way -- total minus available, never df field 3', () => {
    const fint = parseDfMounts(STUDIO).find(v => v.mount === '/Volumes/Fint')
    expect(fint).toEqual({
      usedBytes: (7_813_821_400 - 6_943_845_244) * KB,
      totalBytes: 7_813_821_400 * KB,
      mount: '/Volumes/Fint',
    })
    // df's own `Used` column for this volume is 869,140,320 KB. It excludes the
    // reserve and is a DIFFERENT number; taking it here is the exact bug
    // `node-stats-disk-used-two-definitions` was filed for.
    expect(fint?.usedBytes).not.toBe(869_140_320 * KB)
  })

  it('keeps a mount path that contains spaces intact', () => {
    expect(mounts(parseDfMounts(STUDIO))).toContain('/Volumes/Stuff 1')
  })

  it('skips an unparseable row instead of failing the whole sweep', () => {
    const withJunk = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/disk5 100 40 60 40% /Volumes/Good',
      'this line is garbage',
      '/dev/disk6 nonsense here also 40% /Volumes/Bad',
    ].join('\n')
    expect(mounts(parseDfMounts(withJunk))).toEqual(['/Volumes/Good'])
  })

  it('is empty for no output rather than throwing', () => {
    expect(parseDfMounts('')).toEqual([])
    expect(parseDfMounts('Filesystem 1024-blocks Used Available Capacity Mounted on')).toEqual([])
  })
})

describe('which mounts get a series', () => {
  it('drops a path whose identity is a timestamp -- it would be a NEW object hourly', () => {
    // `name` in `stat_objects` is the mount path and an object row is forever.
    // A TimeMachine local snapshot mounts under a fresh timestamped path every
    // hour, so reporting it is not a series -- it is an unbounded object table.
    expect(
      isReportableMount('/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/x/2026-08-20-193107/Data'),
    ).toBe(false)
    expect(
      isReportableMount('/Volumes/.timemachine/46252966-9D8B-4C46-8BAE-8BF0428AEF7D/2026-08-05-002557.backup'),
    ).toBe(false)
    expect(isReportableMount('/private/var/folders/pf/kvc/X/D0A84DB5-CC23-533B-B9F0-9B3A9B1DF12C')).toBe(false)
  })

  it('drops read-only images that are 98% full by construction', () => {
    // A meter that is permanently red for a volume nobody can free space on is
    // the noise this card exists to remove, not the signal.
    expect(isReportableMount('/Library/Developer/CoreSimulator/Volumes/iOS_23E244')).toBe(false)
    expect(isReportableMount('/snap/core22/1748')).toBe(false)
  })

  it('keeps the disks a human would name', () => {
    for (const mount of ['/', '/System/Volumes/Data', '/Volumes/Fint', '/volume1', '/Volumes/Stuff 1']) {
      expect(isReportableMount(mount)).toBe(true)
    }
  })

  it('drops kernel filesystems, which are permanently full and are not disks', () => {
    // devfs is 252 KB at 100% forever. Left in, fullest-first would hand the top
    // of the list to a filesystem that can never be the answer to "which disk is
    // at 99%".
    expect(isReportableMount('/dev')).toBe(false)
    expect(isReportableMount('/dev/shm')).toBe(false)
    expect(isReportableMount('/run/user/1000')).toBe(false)
  })

  it('matches on path SEGMENTS, so a real volume is never eaten by a prefix', () => {
    // `/dev` is skipped; `/devdata` is somebody's disk.
    expect(isReportableMount('/devdata')).toBe(true)
    expect(isReportableMount('/snapshots')).toBe(true)
  })

  it('names every skipped prefix and why, rather than filtering on a hunch', () => {
    // Both lists are covenants with DIFFERENT reasons -- disposable identity vs
    // not-a-disk. If either count changes, the reason for the new entry belongs
    // beside it in the list it was added to.
    expect(EPHEMERAL_MOUNT_PREFIXES).toHaveLength(6)
    expect(PSEUDO_MOUNT_PREFIXES).toHaveLength(4)
  })
})

describe('selectVolumes -- one store, one series', () => {
  const selected = selectVolumes(parseDfMounts(STUDIO))

  // THE CASE THIS RULE EXISTS FOR. `/`, `/System/Volumes/VM`, `/Preboot`,
  // `/Update` and `/Data` are five volumes in ONE APFS container, and under the
  // one definition of used (total minus available) they report the SAME number:
  // 1,948,455,240 - 282,123,420 blocks, every one of them. Five series that must
  // always agree is five chances to disagree.
  it('collapses an APFS container to a single volume, keeping the shortest path', () => {
    expect(selected.filter(v => v.mount === '/' || v.mount.startsWith('/System/Volumes/'))).toHaveLength(1)
    expect(mounts(selected)).toContain('/')
    expect(mounts(selected)).not.toContain('/System/Volumes/Data')
  })

  it('keeps genuinely separate disks separate', () => {
    expect(mounts(selected)).toContain('/Volumes/Fint')
    expect(mounts(selected)).toContain('/Volumes/downloads')
    expect(mounts(selected)).toContain('/Volumes/Stuff 1')
  })

  it('drops every disposable path', () => {
    expect(mounts(selected).some(m => m.includes('TimeMachine'))).toBe(false)
    expect(mounts(selected).some(m => m.includes('CoreSimulator'))).toBe(false)
  })

  it('puts the FULLEST first -- "which disk is at 99%" is the whole question', () => {
    // `/Volumes/downloads` is at 100%, `/Volumes/Fint` at 11%.
    expect(selected[0]?.mount).toBe('/Volumes/downloads')
    expect(selected.at(-1)?.mount).toBe('/Volumes/Fint')
  })

  it('caps a pathological mount table instead of minting objects without bound', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      usedBytes: i,
      totalBytes: 1_000 + i,
      mount: `/mnt/loop${i}`,
    }))
    expect(selectVolumes(many, 24)).toHaveLength(24)
    // ...and the cap keeps the fullest, not the first 24 df happened to print.
    expect(selectVolumes(many, 3).map(v => v.mount)).toEqual(['/mnt/loop99', '/mnt/loop98', '/mnt/loop97'])
  })

  it('a real box yields a handful, so the cap is a backstop and not a routine trim', () => {
    expect(selected.length).toBeLessThan(24)
  })
})

describe('readVolumes -- against the live box', () => {
  it('reports at least the root volume, with used <= total on every one', () => {
    resetVolumeMountCache()
    const volumes = readVolumes()
    expect(volumes.length).toBeGreaterThan(0)
    for (const volume of volumes) {
      expect(volume.totalBytes).toBeGreaterThan(0)
      expect(volume.usedBytes).toBeLessThanOrEqual(volume.totalBytes)
      expect(volume.mount.length).toBeGreaterThan(0)
    }
    expect(new Set(mounts(volumes)).size).toBe(volumes.length)
  })

  it('does not fork df on the 5s tick -- the mount LIST is cached, the readings are not', () => {
    // The whole reason this is not just "run df every sample": ~17k spawns per
    // node per day to read numbers a syscall hands over.
    resetVolumeMountCache()
    const first = readVolumes(1_000)
    const cached = readVolumes(1_000 + VOLUME_MOUNT_REFRESH_MS - 1)
    expect(mounts(cached)).toEqual(mounts(first))

    // A disk plugged in after the refresh window shows up on the next enumerate.
    const refreshed = readVolumes(1_000 + VOLUME_MOUNT_REFRESH_MS + 1)
    expect(refreshed.length).toBeGreaterThan(0)
  })
})

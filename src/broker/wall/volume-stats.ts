/**
 * THE WALL's per-VOLUME stats producer: one `stat_objects` row per mount.
 *
 * `host-vitals.ts` files `disk_percent` against the NODE, because that is what a
 * node-stats frame used to carry -- one disk block, one mount. On a box at 99%
 * that number says the box is full and cannot say which disk, so the alert is a
 * red meter nobody can act on. `machine.volumes` carries every mount now, and
 * this files each one as its own object.
 *
 * IT DOES NOT TOUCH THE NODE'S NUMBER. `disk_percent` against the `node` still
 * means the volume the agent runs on and is still written by `host-vitals`. This
 * ADDS resolution beside it. A frame from a sender that predates `volumes` files
 * nothing here and its node series is unchanged, which is the entire migration.
 *
 * THE BROKER PROJECTS, IT DOES NOT RECOMPUTE. The bytes are the collector's, and
 * the percentage comes from the same `share()` the node row uses. The reason
 * that rule is written down twice is `node-stats-disk-used-two-definitions`: two
 * code paths computed "used" differently and the fleet quietly disagreed with
 * itself for a day. A percentage and a byte count that do not match here are a
 * bug, never a rounding difference.
 *
 * Its own file rather than more of `host-vitals.ts`: a second producer, a second
 * object kind, and that file is already at its size limit.
 */

import { basename } from 'node:path'
import type { NodeStatsReport, VolumeStats } from '../../shared/node-stats'
import type { StatObjectRef } from '../../shared/stats'
import { recordStat } from '../stats/store'
import { share } from './host-vitals'

/**
 * The volume's stats object: keyed by MOUNT PATH, labelled by its last segment.
 *
 * The mount path is identity -- unlike a hostname (which someone re-points, so
 * the `node` object is keyed by nodeId instead), a mount path is what the volume
 * is called. `/Volumes/Fint` is `/Volumes/Fint` across a reboot, a rename of the
 * box and a broker restart, so the series survives all three.
 *
 * `label` is the last segment, which is the volume's name on every platform that
 * mounts under a directory -- `Fint`, `Data`, `volume1`. Root has no last
 * segment and keeps `/`, because a blank label is worse than a terse one.
 */
export function volumeStatObject(nodeId: string, volume: VolumeStats): StatObjectRef {
  return {
    nodeId,
    kind: 'volume',
    name: volume.mount,
    label: basename(volume.mount) || volume.mount,
  }
}

/**
 * File one frame's volumes. Called from the ONE node-stats ingest body, beside
 * `recordWallHostVitals` and on the same accepted frame -- no second ingest
 * path, no cadence of its own, no validator of its own.
 *
 * Returns how many volumes were filed; the tests assert on it and the caller
 * ignores it.
 *
 * The timestamp is the node's own `sampledAt`, the same instant the node row
 * carries. A box with a skewed clock therefore stores its volumes on the same
 * skewed axis as its node series, rather than on a second, disagreeing one.
 */
export function recordWallVolumeStats(report: NodeStatsReport): number {
  const volumes = report.machine.volumes
  if (!volumes) return 0
  for (const volume of volumes) {
    const ref = volumeStatObject(report.node.nodeId, volume)
    const percent = share(volume.usedBytes, volume.totalBytes)
    // A volume with no denominator has no meter -- absent, never 0%, exactly as
    // the node row treats a missing total. The BYTES are still filed: 0/0 is a
    // volume that could not be measured, and its two byte counts say so.
    if (percent !== undefined) recordStat(ref, 'disk_percent', percent, report.sampledAt)
    recordStat(ref, 'disk_used_bytes', volume.usedBytes, report.sampledAt)
    recordStat(ref, 'disk_total_bytes', volume.totalBytes, report.sampledAt)
  }
  return volumes.length
}

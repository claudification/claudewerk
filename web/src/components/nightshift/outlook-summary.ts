/**
 * The one honest sentence about tonight's list, plus the bucket vocabulary the
 * refusal block renders under.
 *
 * "3 tagged, 1 held by a live conversation, 1 over the cap" is the render the
 * scanner contract was built to make possible: every card the scan selected is
 * either admitted or named. Showing only the survivors would reproduce, in a new
 * place, exactly the silent `queue.slice(0, n)` truncation the scanner replaced.
 *
 * Pure functions, no JSX -- the counting is the part worth testing.
 */

import type { NightshiftOutlook, NightshiftOutlookRefusal } from '@shared/protocol'

/**
 * Human phrasing per bucket. Keyed by the scanner's slugs, NOT a second copy of
 * its vocabulary: the buckets to render come from `outlook.buckets` (the scanner
 * ships its own list), and a bucket with no entry here falls back to its slug.
 * So a bucket added broker-side shows up the day it is added, unlabelled but
 * never dropped.
 */
const BUCKET_LABEL: Record<string, string> = {
  'closed-lane': 'in a closed lane',
  'live-conversation': 'held by a live conversation',
  unreadable: 'unreadable at dispatch time',
  'over-cap': 'over the cap',
}

export function bucketLabel(bucket: string): string {
  return BUCKET_LABEL[bucket] ?? bucket
}

export interface RefusalGroup {
  bucket: string
  label: string
  items: NightshiftOutlookRefusal[]
}

/**
 * Refusals grouped by bucket, in the scanner's declared order, empty buckets
 * dropped. Any refusal carrying a bucket the scanner did not declare is appended
 * at the end rather than lost -- an unaccounted refusal would be the same class
 * of silent drop, one layer up.
 */
export function groupRefusals(outlook: NightshiftOutlook): RefusalGroup[] {
  const seen = new Set<string>()
  const groups: RefusalGroup[] = []
  for (const bucket of [...outlook.buckets, ...outlook.refused.map(r => r.bucket)]) {
    if (seen.has(bucket)) continue
    seen.add(bucket)
    const items = outlook.refused.filter(r => r.bucket === bucket)
    if (items.length > 0) groups.push({ bucket, label: bucketLabel(bucket), items })
  }
  return groups
}

/**
 * The summary sentence. Leads with what WILL run, then names every refusal
 * bucket with a count. `null` when the scan selected nothing -- there is nothing
 * to be honest about and the empty state says it better.
 */
export function summarize(outlook: NightshiftOutlook): string | null {
  if (outlook.selected.length === 0) return null
  const parts = [`${outlook.admitted.length} of ${outlook.selected.length} tagged`]
  for (const group of groupRefusals(outlook)) parts.push(`${group.items.length} ${group.label}`)
  return parts.join(', ')
}

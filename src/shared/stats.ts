/**
 * THE STATS TABLE's vocabulary -- one pinned list of metric names and object
 * kinds, shared so nothing invents a second spelling for a number that already
 * has one.
 *
 * WHY THIS IS PINNED RATHER THAN FREE TEXT. A narrow (metric, value) store is
 * only queryable while everyone agrees on the string. Left open, `cpu` /
 * `cpu_percent` / `cpuPct` all appear inside a month and no query finds all
 * three; the table then holds the data and answers nothing. A union type makes
 * the typo a compile error and keeps "add a stat" at one line.
 *
 * THE UNIT IS IN THE NAME. `_percent`, `_bytes`, `_ms`, `_count`. `value` is a
 * bare REAL, so the name is the only place the unit can live -- and a number
 * whose unit is a guess is a number nobody can render. The
 * `node-stats-disk-used-two-definitions` card exists because two code paths
 * disagreed about what "used" meant; a name that says `_percent` cannot quietly
 * become bytes.
 *
 * ONLY WHAT HAS A PRODUCER IS LISTED. A metric nobody writes is vocabulary that
 * rots. Adding one is: a string here, and a `recordStat()` call at the source.
 */

/**
 * A named thing that lives ON a node and can be measured.
 *
 * `node` and `profile` are the two THE WALL produces. `conversation` is the
 * third, added by the token-usage producer: a conversation lives on exactly one
 * sentinel, so it hangs off a node like the other two. `volume` and `process`
 * are the obvious next ones and are deliberately NOT pre-declared -- see the
 * note above.
 */
export type StatObjectKind = 'node' | 'profile' | 'conversation'

/** Every metric the broker records. Units are part of the name, always. */
export type StatMetric =
  /** Whole-box CPU utilization, 0-100. Producer: `wall/host-vitals`. */
  | 'cpu_percent'
  /** `memory.usedBytes / memory.totalBytes`, 0-100. Producer: `wall/host-vitals`. */
  | 'mem_percent'
  /** `disk.usedBytes / disk.totalBytes` for the reported mount, 0-100.
   *  Producer: `wall/host-vitals`. ONE definition of "used": whatever the
   *  node-stats frame reported, projected by the same `share()` the wall row
   *  uses. Never recomputed a second way. */
  | 'disk_percent'
  /** A profile's FIVE-HOUR plan utilization, 0-100. Producer:
   *  `wall/plan-usage-series`, and only for a reading that actually happened
   *  (`state === 'ok'`) -- an unauthed or errored profile has no number, and
   *  filing its placeholder 0 would draw a line that says "idle". */
  | 'plan_utilization_percent'
  /* THE FOUR BELOW ARE FLOW, NOT GAUGE. Each is a per-EVENT delta -- what ONE
   * assistant message billed -- where every `_percent` above is a level read at
   * an instant. The distinction is not cosmetic: `retention.ts` collapses rows
   * older than 48h with AVG(), which is right for a gauge and lossy for a flow
   * (the mean message, not the window's volume). Known and filed as
   * `wall-stats-retention-flow-vs-gauge`; nothing reads these yet. */
  /** Uncached input tokens billed by ONE assistant message. Producer:
   *  `conversation-store/transcript-handlers/token-stats`. Disjoint from
   *  `cache_read_count` and `cache_write_count` -- the three sum to the
   *  message's total input, which is why none of them double-counts. */
  | 'tokens_in_count'
  /** Output tokens billed by ONE assistant message. Same producer. */
  | 'tokens_out_count'
  /** Prompt-cache READ tokens on ONE assistant message. Same producer. */
  | 'cache_read_count'
  /** Prompt-cache WRITE tokens on ONE assistant message, 5m and 1h summed.
   *  The TTL split stays in `token_samples`; this is the coarser view. */
  | 'cache_write_count'

/**
 * The thing being measured.
 *
 * IDENTITY IS `(nodeId, kind, name)`, AND NONE OF THE THREE MAY BE A LABEL.
 * `name` is the stable key within a kind -- for a `node` that is the nodeId
 * itself, precisely because the hostname is a label someone can re-point and a
 * series must not fork when a box is renamed. The BOUNDARY covenant says a
 * nodeId is identity; the same reasoning makes an alias not one.
 */
export interface StatObjectRef {
  /** The node this object lives ON (sentinel/node id). Identity. */
  nodeId: string
  kind: StatObjectKind
  /** Stable key, unique within `(nodeId, kind)`. Never a mutable label. */
  name: string
  /** Human display label as last seen -- hostname, sentinel alias. Stored
   *  alongside the object and overwritten on every write, NOT part of the key,
   *  so renaming a box updates the label instead of splitting the series. */
  label?: string
}

/** One reading. `ts` is epoch ms in whatever clock the producer stamped -- for
 *  node vitals that is the node's own `sampledAt`, the same instant the wall
 *  row carries, so the stored series and the drawn series cannot disagree. */
export interface StatPoint {
  ts: number
  value: number
}

/** One object's readings for one metric, oldest first. */
export interface StatSeries {
  ref: StatObjectRef
  points: StatPoint[]
}

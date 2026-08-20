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
 * `node`, `profile`, `volume` and `conversation` are the four THE WALL produces
 * today. `process` is the obvious next one and is deliberately NOT pre-declared
 * -- see the note above.
 *
 * A `volume` is named by its MOUNT PATH, and that is the rare case where the
 * human-readable string genuinely is identity: a mount path is what a volume is
 * called, in the way a hostname is never what a box is called. `label` carries
 * the prettier version (`Fint` for `/Volumes/Fint`) and remains a label.
 *
 * A `conversation` lives on exactly one sentinel, so it hangs off a node like
 * the other three: `name` is the conversation id (stable identity) and `label`
 * is its title (mutable).
 */
export type StatObjectKind = 'node' | 'profile' | 'volume' | 'conversation'

/** Every metric the broker records. Units are part of the name, always. */
export type StatMetric =
  /** Whole-box CPU utilization, 0-100. Producer: `wall/host-vitals`. */
  | 'cpu_percent'
  /** `memory.usedBytes / memory.totalBytes`, 0-100. Producer: `wall/host-vitals`. */
  | 'mem_percent'
  /** `usedBytes / totalBytes` for a volume, 0-100. TWO producers, ONE meaning:
   *  `wall/host-vitals` files it against the `node` (the volume the agent runs
   *  on, so the node-level number keeps meaning exactly what it always meant),
   *  and `wall/volume-stats` files it against each `volume` object. Both call
   *  the same `share()` on bytes the collector already computed -- the broker
   *  projects, it never recomputes. A `node` reading and its `volume` reading
   *  that disagree would be the bug, not a rounding difference. */
  | 'disk_percent'
  /** A volume's used bytes, exactly as the collector reported them (total minus
   *  unprivileged-available). Producer: `wall/volume-stats`. Stored beside the
   *  percentage because "89%" cannot tell you whether freeing 10 GB helps. */
  | 'disk_used_bytes'
  /** A volume's size in bytes. Producer: `wall/volume-stats`. Nearly constant,
   *  and stored anyway: without the denominator the byte count above is a number
   *  with no scale, and retention collapses a flat series to almost nothing. */
  | 'disk_total_bytes'
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

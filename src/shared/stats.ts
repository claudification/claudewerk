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
 * THE UNIT IS IN THE NAME. `_percent`, `_bytes`, `_ms`, `_count`, `_usd`. `value` is a
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
 * `node`, `profile`, `volume`, `conversation` and `feature` are the five THE
 * WALL produces today. `process` is the obvious next one and is deliberately NOT
 * pre-declared -- see the note above.
 *
 * A `volume` is named by its MOUNT PATH, and that is the rare case where the
 * human-readable string genuinely is identity: a mount path is what a volume is
 * called, in the way a hostname is never what a box is called. `label` carries
 * the prettier version (`Fint` for `/Volumes/Fint`) and remains a label.
 *
 * A `conversation` lives on exactly one sentinel, so it hangs off a node like
 * the other three: `name` is the conversation id (stable identity) and `label`
 * is its title (mutable).
 *
 * A `feature` is the odd one and is the reason `STATS_BROKER_NODE_ID` exists
 * below: a broker feature that spends money is not a thing sitting on a
 * sentinel. It is filed against the broker's own pinned node id, which is
 * honest -- the spend genuinely happens in the broker process -- and keeps
 * `nodeId` non-optional for everyone else. `name` is the `feature` tag off the
 * `ChatRequest`, a code-level constant rather than a mutable label, and there is
 * no `label`: a feature has no display alias distinct from its key.
 */
export type StatObjectKind = 'node' | 'profile' | 'volume' | 'conversation' | 'feature'

/**
 * THE BROKER'S OWN node id, for objects that live in the broker process rather
 * than on a reporting agent.
 *
 * A real `nodeId` is minted by an agent that reports node stats (see
 * `node-stats.ts`) and the broker is not one, so there is no node to look up.
 * Nor may one be derived from the environment: the broker runs in a container
 * and the BOUNDARY covenant keeps it from reading identity off its host.
 *
 * So it is pinned here, next to the vocabulary it belongs to, for the same
 * reason the metric names are pinned: a second spelling of this id (`'broker'`
 * at one producer, `'the-broker'` at the next) forks a series in a way no query
 * can put back together.
 */
export const STATS_BROKER_NODE_ID = 'broker'

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
  /* THE FOUR TOKEN METRICS BELOW ARE FLOW, NOT GAUGE. Each is a per-EVENT delta
   * -- what ONE assistant message billed -- where every `_percent` above is a
   * level read at an instant. That distinction is what `STAT_FLOW_SUFFIXES`
   * below encodes, and `retention.ts` reads it: these collapse with SUM, the
   * gauges with AVG. Nothing reads the four yet. */
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
  /** US dollars billed by ONE OpenRouter round-trip, filed against the `feature`
   *  that spent them. Producer: `openrouter-spend-stats`, off the ONE sink every
   *  broker LLM call funnels through. ALSO A FLOW -- see `_usd` below -- and the
   *  reason the suffix rule takes a list rather than a single string.
   *
   *  SUCCESSFUL CALLS ONLY. A failed round-trip returns no usage body, so what
   *  it cost the provider is unknowable here; filing 0 would be a claim rather
   *  than a reading. `openrouter-spend.db` keeps the failure accounting (calls,
   *  wall-clock burnt) and is not retired by this series. */
  | 'spend_usd'

/**
 * THE SUFFIXES THAT MAKE A METRIC A FLOW RATHER THAN A GAUGE, and therefore how
 * `retention.ts` is allowed to collapse it into a 5-minute bucket.
 *
 * Two different kinds of number live in one narrow table and they do not
 * summarise the same way:
 *
 *   GAUGE -> the arithmetic MEAN. A level read at an instant. `cpu_percent` at
 *   3pm is 40%; the mean of the levels inside a window is a coarser, honest
 *   version of the same quantity, in the same unit.
 *
 *   FLOW -> the SUM. A per-EVENT delta. `tokens_in_count` is what ONE assistant
 *   message billed. The mean of the messages in a window is "the typical
 *   message", which is a DIFFERENT statistic from "what the window cost":
 *   averaging divides the volume by however many events the bucket held (~28 on
 *   this fleet, up to 108 in a busy one), and the raws it was computed from are
 *   deleted in the same transaction, so nothing can reconstruct it afterwards.
 *   Worse, the error tracks how busy the fleet was, so the coarse tail would
 *   claim the quietest hours were the most expensive.
 *
 * THE UNIT SUFFIX ALREADY CARRIES THE ANSWER, so this is a RULE, not a second
 * list to keep in sync with the union above. `_count` counts things that
 * HAPPENED and `_usd` is money that was SPENT; both are flows. Every other
 * declared unit (`_percent`, `_bytes`, `_ms`) names a level and is a gauge. That
 * keeps "adding a stat is one string" true -- a new `_count` or `_usd` metric is
 * summed the day it is declared, with nothing else to remember and nothing to
 * forget.
 *
 * A LIST OF SUFFIXES, NOT A LIST OF METRICS. Two entries is still a rule about
 * units; a per-metric lookup table would be the thing this design exists to
 * avoid, because it is the thing someone forgets to update.
 *
 * `_usd` IS ONLY A FLOW BECAUSE SPENDING IS AN EVENT -- read this before
 * declaring the next dollar-denominated metric. `spend_usd` is what ONE call
 * cost, so summing a window gives what the window cost. A BALANCE, a PRICE, a
 * LIMIT or a RATE denominated in dollars is a LEVEL: it is read at an instant,
 * it must average, and under this rule a name ending `_usd` would be summed
 * instead -- a credit balance of $40 held steady across a bucket would collapse
 * to $1,120, and the raws proving otherwise are deleted in the same
 * transaction. Do not reach for `_usd` for one of those. Give it a suffix that
 * names the level (`balance_usd_gauge` is ugly; `credit_balance_dollars` is
 * fine) or extend this rule deliberately -- do not let the collision happen by
 * accident.
 */
export const STAT_FLOW_SUFFIXES = ['_count', '_usd'] as const

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

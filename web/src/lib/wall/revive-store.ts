/**
 * THE REVIVE LEDGER -- one record per PULL-FED FEED on THE WALL.
 *
 * The wall's push half already survives a drop: `wall-subscription.ts` re-asserts
 * the channel and the broker answers with a full snapshot. The pull half did not.
 * After a broker restart every HTTP-fed pane healed only on its own timer -- the
 * sheaf at 60s, the 24h token tile at 5min -- and a one-shot mount fetch never
 * healed at all, so the wall rendered fresh websocket numbers beside stale HTTP
 * numbers with nothing on screen telling them apart.
 *
 * KEYED BY FEED, NOT BY PANE, and that is the whole reason this file exists
 * rather than thirteen `useEffect(..., [connectSeq])`. A4 and A6 read ONE sheaf
 * response; keyed by pane, a reconnect would fire two requests for it. Keyed by
 * feed, the second holder finds the pull already issued for this `connectSeq` and
 * takes the answer. Exactly once, however many panes are watching.
 *
 * MODULE SCOPE, like every other wall store, because THE WALL is a managed
 * surface: inline -> docked -> detached -> ambient each unmount the whole tree,
 * and freshness that reset on a surface transition would be a lie about the data,
 * not about the DOM.
 *
 * No React in here. The hook is `use-wall-revive.ts`.
 */

import { createExternalStoreSignal } from '@/hooks/external-store-utils'

/**
 * A pull-fed data source behind one or more panes. Adding a member here is half
 * the job -- the pane must also declare it in `wall-pane-registry.ts`, which is
 * what the census is folded out of.
 */
export type WallFeedId = 'sheaf' | 'burn' | 'commits' | 'fleet-tokens' | 'pins' | 'runs'

/**
 * What a feed does when asked to re-read itself.
 *
 * `false` means IT DID NOT LAND -- a 403, a dead broker, a body that was not
 * JSON. A rejected promise means the same. Either way the feed keeps whatever it
 * last knew and stays marked stale, because the alternative is a pane quietly
 * presenting a pre-disconnect number as a current one.
 */
export type WallReload = () => Promise<boolean | void>

interface FeedRecord {
  /** Panes currently holding this feed. */
  holders: number
  /** The reload the holders share. Every holder of one feed passes the same one. */
  reload: WallReload | null
  /** connectSeq the last pull was ISSUED for. Dedupes sibling panes. */
  issuedSeq: number | null
  /** connectSeq of the last pull that actually LANDED. */
  freshSeq: number | null
  /** Broker-independent clock of that landing, for the surface to print. */
  freshAt: number | null
  /** Poll timer, owned by the first holder and stopped by the last. */
  timer: ReturnType<typeof setInterval> | null
  /** How many times this feed has been pulled. The exactly-once test reads it. */
  pulls: number
}

const feeds = new Map<WallFeedId, FeedRecord>()
const signal = createExternalStoreSignal()

function record(feed: WallFeedId): FeedRecord {
  let rec = feeds.get(feed)
  if (!rec) {
    rec = { holders: 0, reload: null, issuedSeq: null, freshSeq: null, freshAt: null, timer: null, pulls: 0 }
    feeds.set(feed, rec)
  }
  return rec
}

/**
 * Take a hold on a feed. Returns TRUE on the 0->1 transition.
 *
 * The caller uses that to force a pull, and the reason is the surface: a wall
 * moving inline -> detached unmounts the whole tree, so a feed whose rows live in
 * component state came back empty. "Already pulled for this connection" is only
 * true while somebody is still holding the answer.
 */
export function acquireFeed(feed: WallFeedId, reload: WallReload): boolean {
  const rec = record(feed)
  rec.holders++
  rec.reload = reload
  signal.bump()
  return rec.holders === 1
}

/** Release a hold. At zero the poll timer stops -- a closed wall polls nothing --
 *  but the freshness marks stay: they describe the DATA, not the mount. */
export function releaseFeed(feed: WallFeedId): void {
  const rec = feeds.get(feed)
  if (!rec || rec.holders === 0) return
  rec.holders--
  if (rec.holders === 0 && rec.timer) {
    clearInterval(rec.timer)
    rec.timer = null
  }
  signal.bump()
}

/**
 * Pull a feed for a given connection.
 *
 * `seq` is the `connectSeq` this pull belongs to. A second holder calling with
 * the same seq is a no-op -- that is the "exactly once per reconnect" guarantee,
 * enforced here rather than trusted to each pane.
 *
 * `force` is the poll tick: same connection, deliberate re-read.
 */
export async function pullFeed(feed: WallFeedId, seq: number, force = false): Promise<void> {
  const rec = record(feed)
  if (!force && rec.issuedSeq === seq) return
  const reload = rec.reload
  if (!reload) return
  rec.issuedSeq = seq
  rec.pulls++
  try {
    const landed = await reload()
    if (landed === false) return
    rec.freshSeq = seq
    rec.freshAt = Date.now()
  } catch {
    // Kept stale on purpose. See WallReload.
  } finally {
    signal.bump()
  }
}

/**
 * Drive the feed's own poll clock, if it has one. Idempotent: ten panes calling
 * it means one timer.
 *
 * The timer's life is tied to the HOLDERS, not to whoever happened to start it --
 * `releaseFeed` stops it at zero. Tying it to a single pane's effect would stop
 * the sheaf's minute clock the moment A6 unmounted and leave A4 polling nothing.
 */
export function ensureFeedPoll(feed: WallFeedId, everyMs: number, seqOf: () => number): void {
  const rec = record(feed)
  if (rec.timer) return
  rec.timer = setInterval(() => void pullFeed(feed, seqOf(), true), everyMs)
}

export interface WallFreshness {
  /** Has this feed ever landed anything? Nothing to call stale if not. */
  loaded: boolean
  /** It landed, but on an OLDER connection than the one we are on now. */
  stale: boolean
  /** When it last landed. `null` = never. */
  at: number | null
}

const NEVER: WallFreshness = { loaded: false, stale: false, at: null }

export function feedFreshness(feed: WallFeedId, seq: number): WallFreshness {
  const rec = feeds.get(feed)
  if (!rec || rec.freshSeq === null) return NEVER
  return { loaded: true, stale: rec.freshSeq !== seq, at: rec.freshAt }
}

/** How many times a feed has been pulled, ever. Test seam for done-means 4. */
export function feedPulls(feed: WallFeedId): number {
  return feeds.get(feed)?.pulls ?? 0
}

/** Feeds with at least one pane holding them right now. This is the RUNTIME half
 *  of the census -- what actually registered, against what the registry declared. */
export function registeredFeeds(): Set<WallFeedId> {
  const live = new Set<WallFeedId>()
  for (const [feed, rec] of feeds) if (rec.holders > 0) live.add(feed)
  return live
}

/** Test isolation: forget every hold, every timer and every freshness mark. */
export function resetWallRevive(): void {
  for (const rec of feeds.values()) if (rec.timer) clearInterval(rec.timer)
  feeds.clear()
  signal.bump()
}

export const subscribeRevive = signal.subscribe
export const reviveVersion = signal.getVersion

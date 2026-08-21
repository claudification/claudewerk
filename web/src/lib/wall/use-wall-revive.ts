/**
 * `useWallRevive(feed, reload)` -- THE ONE SEAM every pull-fed pane on THE WALL
 * registers with.
 *
 * `connectSeq` is this codebase's established reconnect signal
 * (`use-project-list-store.ts`, `use-canvas-room.ts`, `use-orb-watches.ts` all
 * re-pull on it) and until this card nothing on the wall read it. One hook, one
 * dependency, one place where "the socket came back" turns into "read it again" --
 * rather than thirteen hand-written effects, twelve of which would be right.
 *
 * WHAT IT DOES, in order:
 *   1. holds the feed, so the census can see the pane registered (the check that
 *      makes this seam un-stubbable lives in `wall-revive-census.ts`);
 *   2. pulls once per (feed, connection) -- siblings on one feed share the answer;
 *   3. runs the feed's poll clock, if it has one, for the ordinary case where
 *      nothing dropped;
 *   4. returns FRESHNESS, so a pane that is showing a number from before the
 *      disconnect can say so instead of presenting it as current.
 *
 * Point 4 is not decoration. Through a broker restart the 24h token tile showed
 * its last good number, confidently, forever -- a wall meant to be trusted from
 * across a room with nobody touching it.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import {
  acquireFeed,
  feedFreshness,
  pullFeed,
  releaseFeed,
  reviveVersion,
  setFeedPoll,
  subscribeRevive,
  type WallFeedId,
  type WallFreshness,
  type WallReload,
} from './revive-store'

const currentSeq = (): number => useConversationsStore.getState().connectSeq

/**
 * @param feed  the id this pane declares in `wall-pane-registry.ts`
 * @param reload  re-read the feed. `false` or a rejection = it did not land
 * @param everyMs  the feed's own refresh clock, when it has one. MAY CHANGE
 *   between renders -- a new value re-arms the clock and pulls nothing.
 */
export function useWallRevive(feed: WallFeedId, reload: WallReload, everyMs?: number): WallFreshness {
  const connectSeq = useConversationsStore(s => s.connectSeq)

  // The reload closes over the caller's current props; the HOLD outlives any one
  // render. A ref keeps the two from fighting -- re-registering on every render
  // would re-pull on every render.
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // THE HOLD AND THE PULL. `everyMs` is deliberately NOT in these deps: this
  // effect FETCHES, so anything listed here is a re-pull trigger, and a poll rate
  // is not a reason to re-read. It used to be listed, which is why A2 could not
  // hold a per-window clock -- one click across the 24h/3d boundary would fire
  // the period change's own pull AND a second one from re-registering here.
  useEffect(() => {
    const first = acquireFeed(feed, () => reloadRef.current())
    // `first` FORCES the pull. A re-acquire from zero means the previous holders'
    // component state is gone with them, so "already pulled for this connection"
    // no longer describes anything that is on screen.
    void pullFeed(feed, connectSeq, first)
    return () => releaseFeed(feed)
  }, [feed, connectSeq])

  // THE CLOCK, on its own, because it does not fetch. `setFeedPoll` is a no-op at
  // an unchanged rate, so this runs on every reconnect for free -- and it HAS to,
  // because the release above drops the timer at zero holders and nothing else
  // would put it back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectSeq is a RE-ARM key, not a value this effect reads -- the release above stops the timer at zero holders and this is what puts it back
  useEffect(() => {
    setFeedPoll(feed, everyMs, currentSeq)
  }, [feed, everyMs, connectSeq])

  useSyncExternalStore(subscribeRevive, reviveVersion, reviveVersion)
  return feedFreshness(feed, connectSeq)
}

/**
 * Subscribe to the revive ledger WITHOUT holding a feed.
 *
 * The header's link dot reads every held feed's freshness but owns none of them,
 * and a hold would be a lie the census reads: it counts panes that registered a
 * feed, and the header is not a pane.
 */
export function useWallReviveVersion(): number {
  return useSyncExternalStore(subscribeRevive, reviveVersion, reviveVersion)
}

/**
 * IS THE WALL ACTUALLY LIVE? -- the arithmetic behind the header dot.
 *
 * The dot was a hardcoded green circle on a 2s pulse animation, wired to
 * nothing. It said LIVE while the socket was down, while a feed had never
 * loaded, and while a pane was showing a number from before a broker restart.
 * Reported 2026-08-20: "i have no way to refresh the wall? or see if it is
 * ACTUALLY connected, or aquiering connection etc.."
 *
 * The wall has two halves and both have to be true before LIVE is honest: the
 * PUSH half (the websocket, `isConnected`) and the PULL half (every HTTP-fed
 * pane, whose freshness the revive ledger already tracks per connection). A live
 * socket beside a pane that last landed two connections ago is not a live wall,
 * it is a live socket -- and the pane is the part being read from across a room.
 *
 * Pure, and separate from the component, so the states can be tested without
 * mounting thirteen panes.
 */

import type { WallFreshness } from './revive-store'

export type WallLink = 'offline' | 'loading' | 'syncing' | 'live'

export interface WallLinkView {
  link: WallLink
  /** The word in the header. */
  label: string
  /** Why, for the title attribute. Always answerable. */
  why: string
  /** May the dot pulse? Only a wall that is genuinely current. */
  pulse: boolean
}

export interface WallLinkInput {
  /** The websocket half. */
  connected: boolean
  /** Freshness of every pull-fed feed a pane is currently holding. */
  feeds: readonly WallFreshness[]
}

const VIEW: Record<WallLink, Omit<WallLinkView, 'why'>> = {
  offline: { link: 'offline', label: 'OFFLINE', pulse: false },
  loading: { link: 'loading', label: 'LOADING', pulse: false },
  syncing: { link: 'syncing', label: 'SYNCING', pulse: false },
  live: { link: 'live', label: 'LIVE', pulse: true },
}

const of = (link: WallLink, why: string): WallLinkView => ({ ...VIEW[link], why })

export function wallLinkState(input: WallLinkInput): WallLinkView {
  if (!input.connected) {
    return of('offline', 'The websocket is down. Nothing on this wall is updating -- reconnecting automatically.')
  }

  const waiting = input.feeds.filter(f => !f.loaded).length
  if (waiting > 0) {
    return of('loading', `Connected. ${waiting} feed(s) have not landed yet.`)
  }

  const stale = input.feeds.filter(f => f.stale).length
  if (stale > 0) {
    return of(
      'syncing',
      `Connected, but ${stale} feed(s) last landed on an earlier connection -- those panes are showing pre-disconnect numbers.`,
    )
  }

  return of('live', 'Connected, and every pane has landed on this connection.')
}

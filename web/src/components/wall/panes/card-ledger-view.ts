/**
 * P3's one piece of surface state: ALL or DONE.
 *
 * MODULE SCOPE, for the same reason `wall-filter-store` and `wall-pulse-state`
 * are: THE WALL moves between inline, docked, detached and ambient, and every
 * one of those transitions unmounts the tree. A `useState` here would silently
 * flip the pane back to ALL each time the surface was popped out -- which is
 * exactly when you are least likely to notice it happened.
 *
 * NOT A FILTER. This is a VIEW, chosen with a tab, and it is applied before
 * `useWallFilter` ever runs -- so `{matched}/{total}` keeps meaning "of what
 * this view holds, how much the query box left", which is the only reading that
 * stays true with a tab up.
 */

import { create } from 'zustand'

type CardLedgerView = 'all' | 'done'

interface CardLedgerViewState {
  view: CardLedgerView
  setView(view: CardLedgerView): void
}

export const useCardLedgerViewStore = create<CardLedgerViewState>(set => ({
  view: 'all',
  setView: view => set({ view }),
}))

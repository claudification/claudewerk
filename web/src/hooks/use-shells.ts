/**
 * Host-shell store -- the global floating-shell roster + per-viewer subscription
 * state, mirrored from the broker's permission-filtered roster broadcasts.
 *
 * Shells are to the top bar what conversations are to the sidebar: a global,
 * permission-filtered list (`roster`) with a cheap always-on activity signal
 * (`activity`) and lazy per-viewer byte subscription (`subscribed`). The byte
 * stream itself (`shell_data` / `shell_replay`) does NOT live here -- it is
 * latency-critical and routes straight to the mounted ShellPane via the
 * data-handler registry below (mirrors terminalHandler).
 *
 * SELECTOR DISCIPLINE: every exported hook selects a PRIMITIVE or a stable
 * store-owned reference -- never a freshly-built object/array literal. Returning
 * `Object.values(roster)` from a selector would mint a new array each render and
 * trip React #185 (see feedback_zustand_no_object_selectors). Components select
 * the record/whole-map and derive arrays in `useMemo`.
 */

import type { ShellRosterEntry } from '@shared/protocol'
import { create } from 'zustand'

interface ShellsState {
  /** shellId -> roster entry. Stable identity until a roster mutation. */
  roster: Record<string, ShellRosterEntry>
  /** shellId -> last activity timestamp (drives the blink/recency light). */
  activity: Record<string, number>
  /** shellId -> true while THIS client is subscribed (expanded). Set-like. */
  subscribed: Record<string, true>

  setRoster(shells: ShellRosterEntry[]): void
  addShell(shell: ShellRosterEntry): void
  removeShell(shellId: string): void
  markActivity(shellId: string, ts: number): void
  markSubscribed(shellId: string): void
  markUnsubscribed(shellId: string): void
  reset(): void
}

export const useShellsStore = create<ShellsState>(set => ({
  roster: {},
  activity: {},
  subscribed: {},

  setRoster: shells =>
    set(() => {
      const roster: Record<string, ShellRosterEntry> = {}
      for (const s of shells) roster[s.shellId] = s
      return { roster }
    }),

  addShell: shell => set(state => ({ roster: { ...state.roster, [shell.shellId]: shell } })),

  removeShell: shellId =>
    set(state => {
      if (!state.roster[shellId] && !state.activity[shellId] && !state.subscribed[shellId]) return state
      const { [shellId]: _r, ...roster } = state.roster
      const { [shellId]: _a, ...activity } = state.activity
      const { [shellId]: _s, ...subscribed } = state.subscribed
      return { roster, activity, subscribed }
    }),

  markActivity: (shellId, ts) => set(state => ({ activity: { ...state.activity, [shellId]: ts } })),

  markSubscribed: shellId => set(state => ({ subscribed: { ...state.subscribed, [shellId]: true } })),

  markUnsubscribed: shellId =>
    set(state => {
      if (!state.subscribed[shellId]) return state
      const { [shellId]: _s, ...subscribed } = state.subscribed
      return { subscribed }
    }),

  reset: () => set({ roster: {}, activity: {}, subscribed: {} }),
}))

// ─── per-field selector hooks (primitive / stable-ref only) ──────────────────

/** The whole roster record. Derive arrays in a `useMemo` at the call site. */
export const useShellRoster = () => useShellsStore(s => s.roster)
export const useIsShellSubscribed = (shellId: string) => useShellsStore(s => !!s.subscribed[shellId])
export const useShellActivityTs = (shellId: string) => useShellsStore(s => s.activity[shellId])
export const useShellEntry = (shellId: string) => useShellsStore(s => s.roster[shellId])

// ─── data-plane handler registry (latency-critical, bypasses zustand) ────────
// One ShellPane per shellId registers a handler on mount; the WS dispatcher
// (use-websocket.ts) routes inbound `shell_data` / `shell_replay` straight to it
// without touching the store -- same model as terminalHandler, but keyed so N
// shells can stream concurrently.

export interface ShellDataMessage {
  type: 'shell_data' | 'shell_replay'
  shellId: string
  data: string
  done?: boolean
}

type ShellDataHandler = (msg: ShellDataMessage) => void

const shellDataHandlers = new Map<string, ShellDataHandler>()

export function setShellDataHandler(shellId: string, handler: ShellDataHandler | null): void {
  if (handler) shellDataHandlers.set(shellId, handler)
  else shellDataHandlers.delete(shellId)
}

export function dispatchShellData(msg: ShellDataMessage): void {
  shellDataHandlers.get(msg.shellId)?.(msg)
}

/**
 * Broker-side host-shell roster + viewer registry.
 *
 * A host shell is sentinel-owned and URI-addressed (`claude://{sentinel}/{path}`),
 * but the BROKER owns the global roster fact and the per-viewer subscription
 * bookkeeping (plan-host-shell.md 2/3). This module is the source of truth for:
 *
 *  - the global `shell_roster` (every live shell across every sentinel), built
 *    OPTIMISTICALLY from the authorized `shell_open` (no sentinel ack exists);
 *  - per-shell subscriber set + each viewer's desired size, reduced to the single
 *    authoritative PTY size via the tmux-style `minSize()` policy (which lives
 *    in `src/sentinel/shell-pty.ts` because viewer identity only exists here --
 *    the broker computes the min and hands the sentinel the result verbatim,
 *    see 4.1);
 *  - the dedicated shell-data WS sockets, paired to their control sentinel by
 *    machineId so data-plane frames (`shell_attach`/`shell_detach`/`shell_input`/
 *    `shell_resize`) route over the right pipe.
 *
 * Pure of WebSocket *send* concerns: it stores socket refs and decides WHAT
 * should happen (attach / resize / detach / fan-out targets); the handler in
 * `handlers/shell.ts` does the actual `.send()`. That split keeps the policy
 * unit-testable without a live socket.
 */

import type { ServerWebSocket } from 'bun'
import { minSize } from '../sentinel/shell-pty'
import type { ShellRoster, ShellRosterEntry } from '../shared/protocol'
import { resolvePermissions, type UserGrant } from './permissions'

/** Default viewport handed to the sentinel when a shell has no live viewer
 *  (matches the `minSize()` fallback so a re-attach with zero viewers is sane). */
const DEFAULT_SIZE = { cols: 80, rows: 24 }

interface Size {
  cols: number
  rows: number
}

export interface BrokerShell {
  entry: ShellRosterEntry
  /** UI-grouping only: the conversation the open chord fired from, if any.
   *  Drives the `TranscriptShellEntry` receipt on open/exit. NOT ownership. */
  conversationId?: string
  /** machineId of the owning sentinel -- the data-WS pairing key. Stored at
   *  open so data-plane routing never re-derives it (and survives a control
   *  reconnect that mints a fresh sentinelId). */
  machineId?: string
  /** Subscribers (expanded viewers) -> each one's desired viewport. */
  viewers: Map<ServerWebSocket<unknown>, Size>
  /** The size we last told the sentinel (via attach/resize). Lets us suppress
   *  no-op resizes when a new viewer doesn't shrink the min. */
  sentSize: Size
  /** True once we've sent `shell_attach` (≥1 viewer) and not yet detached. */
  attached: boolean
}

/** What the handler must do on the data WS after a subscribe. */
export type SubscribeAction =
  | { kind: 'attach'; cols: number; rows: number }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'noop' }

/** What the handler must do on the data WS after an unsubscribe / viewer drop. */
export type UnsubscribeAction = { kind: 'detach' } | { kind: 'resize'; cols: number; rows: number } | { kind: 'noop' }

/** Shared subset of both action unions -- a min-size recompute outcome. */
type ResizeAction = { kind: 'resize'; cols: number; rows: number } | { kind: 'noop' }

/** Reduce a shell's current viewer sizes to the single authoritative PTY size. */
function currentMin(shell: BrokerShell): Size {
  return minSize([...shell.viewers.values()], DEFAULT_SIZE)
}

function sameSize(a: Size, b: Size): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

/** Recompute the min across a shell's viewers and emit a `resize` action when it
 *  differs from what the sentinel last got, else `noop`. Shared by subscribe /
 *  unsubscribe / resize so the size-diff logic lives in one place. */
function resizeAction(shell: BrokerShell): ResizeAction {
  const min = currentMin(shell)
  if (sameSize(min, shell.sentSize)) return { kind: 'noop' }
  shell.sentSize = min
  return { kind: 'resize', cols: min.cols, rows: min.rows }
}

/**
 * Filter a roster down to the entries a set of grants may SEE. Roster
 * visibility is gated on `terminal:read` for the shell's URI -- the same gate as
 * subscribing (if you can't watch it, you don't see the tile). Driving
 * (`terminal`) is the stricter write gate enforced at input / close. Pure --
 * unit-testable without a registry.
 *
 * `undefined` grants = infrastructure / bearer-admin connection: sees all.
 */
export function filterRosterForGrants(entries: ShellRosterEntry[], grants?: UserGrant[]): ShellRosterEntry[] {
  if (!grants) return entries
  return entries.filter(e => resolvePermissions(grants, e.projectUri).permissions.has('terminal:read'))
}

export class BrokerShellRegistry {
  private shells = new Map<string, BrokerShell>()
  /** machineId -> dedicated shell-data WS socket for that sentinel. */
  private dataSockets = new Map<string, ServerWebSocket<unknown>>()

  /** Number of live shells (all sentinels). */
  get count(): number {
    return this.shells.size
  }

  has(shellId: string): boolean {
    return this.shells.has(shellId)
  }

  /**
   * Register an optimistically-opened shell. Returns false (no-op) if the
   * shellId is already known -- the open is then a duplicate the caller drops.
   */
  add(entry: ShellRosterEntry, opts: { conversationId?: string; machineId?: string } = {}): boolean {
    if (this.shells.has(entry.shellId)) return false
    this.shells.set(entry.shellId, {
      entry,
      conversationId: opts.conversationId,
      machineId: opts.machineId,
      viewers: new Map(),
      sentSize: { ...DEFAULT_SIZE },
      attached: false,
    })
    return true
  }

  get(shellId: string): BrokerShell | undefined {
    return this.shells.get(shellId)
  }

  /** Roster entries for every live shell (unfiltered). */
  list(): ShellRosterEntry[] {
    return [...this.shells.values()].map(s => s.entry)
  }

  /** Remove a shell (PTY exit / sentinel gone). Returns the removed record so
   *  the caller can emit a transcript receipt + notify viewers. */
  remove(shellId: string): BrokerShell | undefined {
    const shell = this.shells.get(shellId)
    if (shell) this.shells.delete(shellId)
    return shell
  }

  /** Remove every shell owned by a sentinel (control-WS disconnect). Returns the
   *  removed records so the caller can broadcast `shell_removed` for each. */
  removeBySentinel(sentinelId: string): BrokerShell[] {
    const removed: BrokerShell[] = []
    for (const [id, shell] of this.shells) {
      if (shell.entry.sentinelId === sentinelId) {
        this.shells.delete(id)
        removed.push(shell)
      }
    }
    return removed
  }

  /** Subscribers currently watching a shell (data fan-out targets). */
  subscribers(shellId: string): ServerWebSocket<unknown>[] {
    const shell = this.shells.get(shellId)
    return shell ? [...shell.viewers.keys()] : []
  }

  /**
   * Add (or re-size an existing) viewer. Returns the data-WS action the handler
   * must take: `attach` on the first viewer (triggers replay), `resize` when the
   * new min differs from what the sentinel last got, else `noop`. Null when the
   * shell is unknown.
   */
  subscribe(shellId: string, ws: ServerWebSocket<unknown>, cols: number, rows: number): SubscribeAction | null {
    const shell = this.shells.get(shellId)
    if (!shell) return null
    const wasEmpty = shell.viewers.size === 0
    shell.viewers.set(ws, { cols, rows })
    if (wasEmpty) {
      shell.attached = true
      shell.sentSize = currentMin(shell)
      return { kind: 'attach', cols: shell.sentSize.cols, rows: shell.sentSize.rows }
    }
    return resizeAction(shell)
  }

  /**
   * Drop a viewer. Returns `detach` when the last viewer left, `resize` when the
   * surviving viewers' min changed, else `noop`. Null when the shell is unknown
   * or the ws was not a viewer.
   */
  unsubscribe(shellId: string, ws: ServerWebSocket<unknown>): UnsubscribeAction | null {
    const shell = this.shells.get(shellId)
    if (!shell || !shell.viewers.has(ws)) return null
    shell.viewers.delete(ws)
    if (shell.viewers.size === 0) {
      shell.attached = false
      return { kind: 'detach' }
    }
    return resizeAction(shell)
  }

  /**
   * Update one viewer's desired size. Returns `resize` when the new min differs
   * from the last-sent size, else `noop`. Null when the shell is unknown or the
   * ws is not currently a subscriber (a resize from a non-viewer is ignored).
   */
  resize(shellId: string, ws: ServerWebSocket<unknown>, cols: number, rows: number): UnsubscribeAction | null {
    const shell = this.shells.get(shellId)
    if (!shell || !shell.viewers.has(ws)) return null
    shell.viewers.set(ws, { cols, rows })
    return resizeAction(shell)
  }

  /**
   * Drop a disconnected web socket from every shell it was watching. Returns one
   * entry per affected shell with the resulting data-WS action so the handler
   * can quiesce the sentinel (`noop` actions are harmlessly forwarded + ignored).
   */
  dropViewerSocket(
    ws: ServerWebSocket<unknown>,
  ): Array<{ shellId: string; machineId?: string; action: UnsubscribeAction }> {
    const out: Array<{ shellId: string; machineId?: string; action: UnsubscribeAction }> = []
    for (const [shellId, shell] of this.shells) {
      if (!shell.viewers.has(ws)) continue
      const action = this.unsubscribe(shellId, ws)
      if (action) out.push({ shellId, machineId: shell.machineId, action })
    }
    return out
  }

  // ── Data-WS pairing (machineId-keyed) ────────────────────────────────

  /** Pair a sentinel's dedicated shell-data socket by machineId. Replaces any
   *  prior socket for that machine (reconnect). */
  setDataSocket(machineId: string, ws: ServerWebSocket<unknown>): void {
    this.dataSockets.set(machineId, ws)
  }

  /** The shell-data socket for a shell's owning sentinel (or undefined). */
  dataSocketFor(shellId: string): ServerWebSocket<unknown> | undefined {
    const shell = this.shells.get(shellId)
    if (!shell?.machineId) return undefined
    return this.dataSockets.get(shell.machineId)
  }

  /** Forget a data socket on disconnect. Returns the machineId it was paired to. */
  removeDataSocket(ws: ServerWebSocket<unknown>): string | undefined {
    for (const [machineId, sock] of this.dataSockets) {
      if (sock === ws) {
        this.dataSockets.delete(machineId)
        return machineId
      }
    }
    return undefined
  }

  /**
   * On a (re)paired data socket, the shells that still have viewers and so must
   * be re-attached, with their current authoritative size + whether replay is
   * wanted (always true -- a reconnect means the client needs a fresh repaint).
   */
  shellsNeedingReattach(machineId: string): Array<{ shellId: string; cols: number; rows: number }> {
    const out: Array<{ shellId: string; cols: number; rows: number }> = []
    for (const [shellId, shell] of this.shells) {
      if (shell.machineId !== machineId || shell.viewers.size === 0) continue
      const min = currentMin(shell)
      shell.sentSize = min
      shell.attached = true
      out.push({ shellId, cols: min.cols, rows: min.rows })
    }
    return out
  }
}

/** Build a per-client roster snapshot message, filtered to what `grants` may see. */
export function buildRosterSnapshot(registry: BrokerShellRegistry, grants?: UserGrant[]): ShellRoster {
  return { type: 'shell_roster', shells: filterRosterForGrants(registry.list(), grants) }
}

/** Process-lifetime singleton -- the roster is broker-global, not per-connection. */
export const shellRegistry = new BrokerShellRegistry()

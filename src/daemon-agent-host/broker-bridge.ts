/**
 * broker-bridge -- wires a daemon worker's attached PTY to the broker transport.
 *
 * Two directions:
 *   - Worker PTY output (raw bytes from `AttachHandle.onData`) -> broker as
 *     `terminal_data` messages via `feedPty()`.
 *   - Broker raw-terminal messages (`terminal_data` / `terminal_resize` /
 *     `terminal_attach` / `terminal_detach`) -> worker PTY via the
 *     `AttachHandle` methods (`writeInput`, `resize`), routed through
 *     `handleMessage()`. Chat-box `input` is NOT handled here -- the daemon
 *     host routes it to the cc-daemon `reply` op (see `daemon-control.ts`).
 *
 * The bridge owns NO state beyond a `stopped` flag and the CURRENT attach
 * handle. Lifecycle of both the `HostTransport` and the `AttachHandle` is
 * managed by the caller (index.ts). On a socket-drop re-attach the caller
 * swaps in the new handle via `setAttachHandle()`. Stopping the bridge is
 * idempotent and does NOT close the attach handle.
 */

import type { AttachHandle } from '../shared/cc-daemon/attach'
import type { HostTransport } from '../shared/host-transport'
import type { BrokerMessage, TerminalAttach, TerminalData, TerminalDetach, TerminalResize } from '../shared/protocol'

export interface BrokerBridgeOptions {
  transport: HostTransport
  attachHandle: AttachHandle
  conversationId: string
  debug?: (msg: string) => void
}

export interface BrokerBridge {
  /** Feed raw PTY bytes (from attach()'s onData callback) to the broker as terminal_data. */
  feedPty(pty: Buffer): void
  /** Route one inbound broker message. Returns true if it was consumed (a raw-terminal message). */
  handleMessage(msg: BrokerMessage): boolean
  /** Swap in a new attach handle after a socket-drop re-attach. */
  setAttachHandle(handle: AttachHandle): void
  /** Stop the bridge. Idempotent. */
  stop(): void
}

export function createBrokerBridge(opts: BrokerBridgeOptions): BrokerBridge {
  const { transport, conversationId, debug } = opts
  let attachHandle = opts.attachHandle
  let stopped = false

  function feedPty(pty: Buffer): void {
    if (stopped) return
    transport.send({ type: 'terminal_data', conversationId, data: pty.toString('utf8') } satisfies TerminalData)
  }

  function handleMessage(msg: BrokerMessage): boolean {
    if (stopped) return false

    const type = (msg as { type?: string }).type

    switch (type) {
      case 'terminal_data': {
        const m = msg as TerminalData
        if (!attachHandle.closed) {
          attachHandle.writeInput(m.data)
        } else {
          debug?.(`broker-bridge: terminal_data dropped -- attach handle closed (conversationId=${conversationId})`)
        }
        return true
      }

      case 'terminal_resize': {
        const m = msg as TerminalResize
        if (!attachHandle.closed) {
          attachHandle.resize(m.cols, m.rows).catch((err: unknown) => {
            debug?.(
              `broker-bridge: terminal_resize failed -- ${err instanceof Error ? err.message : String(err)} (conversationId=${conversationId})`,
            )
          })
        } else {
          debug?.(`broker-bridge: terminal_resize dropped -- attach handle closed (conversationId=${conversationId})`)
        }
        return true
      }

      case 'terminal_attach': {
        const m = msg as TerminalAttach
        if (!attachHandle.closed) {
          attachHandle.resize(m.cols, m.rows).catch((err: unknown) => {
            debug?.(
              `broker-bridge: terminal_attach resize failed -- ${err instanceof Error ? err.message : String(err)} (conversationId=${conversationId})`,
            )
          })
        } else {
          debug?.(
            `broker-bridge: terminal_attach resize dropped -- attach handle closed (conversationId=${conversationId})`,
          )
        }
        return true
      }

      case 'terminal_detach': {
        // Attach is persistent regardless of viewers -- no action needed.
        void (msg as TerminalDetach)
        return true
      }

      default:
        return false
    }
  }

  function setAttachHandle(handle: AttachHandle): void {
    attachHandle = handle
    debug?.(`broker-bridge: attach handle swapped (conversationId=${conversationId})`)
  }

  function stop(): void {
    stopped = true
  }

  return { feedPty, handleMessage, setAttachHandle, stop }
}

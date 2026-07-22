/**
 * The TOOL BRIDGE: what happens when the voice model calls a function.
 *
 * Two destinations, one seam:
 *   - CLIENT-LOCAL verbs (`control_screen`, `reload_yourself`) are answered in
 *     the browser -- they move the panel or restart the session, so a round trip
 *     to the broker would be pointless (the server impl is a stub).
 *   - Everything else goes over the dashboard WebSocket as `voice_tool_call`
 *     and is answered by the broker's gated handler as `voice_tool_call_result`,
 *     correlated by requestId.
 *
 * The sender and the local handlers are INJECTED, so this whole file is
 * unit-testable with no WebSocket and no React.
 *
 * A pending call ALWAYS settles: on a result, on a timeout, or on dispose
 * (session torn down). A hung promise here would freeze the model mid-turn with
 * no way back -- it waits on the function_call_output before it can speak again.
 */

import type { FunctionCall } from './realtime-events'

/** A verb the browser answers itself. Returning a value is enough; it is JSON
 *  encoded straight back into the model's context. */
export type LocalTool = (args: Record<string, unknown>) => unknown | Promise<unknown>

export interface ToolBridgeOptions {
  /** Wire sender -- `wsSend` in the app, a spy in tests. */
  send(type: string, data: Record<string, unknown>): void
  /** Client-local verbs by name. */
  local?: Record<string, LocalTool>
  /** How long to wait for a broker reply before giving the model an error. */
  timeoutMs?: number
  /** Correlation id source (injected for deterministic tests). */
  newRequestId?: () => string
}

export interface ToolResultMessage {
  requestId?: string
  ok?: boolean
  name?: string
  result?: unknown
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

interface Pending {
  settle: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ToolBridge {
  /** Run one model tool call and resolve with the value to hand back. Never
   *  rejects -- a failure resolves to `{ error }` so the model can say so. */
  run(call: FunctionCall): Promise<unknown>
  /** Feed in a `voice_tool_call_result` from the WS handler. */
  deliver(msg: ToolResultMessage): void
  /** Settle everything outstanding (session closed). */
  dispose(): void
}

export function createToolBridge(opts: ToolBridgeOptions): ToolBridge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const newRequestId = opts.newRequestId ?? (() => `vtc_${crypto.randomUUID()}`)
  const local = opts.local ?? {}
  const pending = new Map<string, Pending>()

  function settle(requestId: string, value: unknown): void {
    const entry = pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.settle(value)
  }

  async function run(call: FunctionCall): Promise<unknown> {
    const localTool = local[call.name]
    if (localTool) {
      try {
        return await localTool(call.args)
      } catch (e) {
        return { error: `${call.name} failed in the panel: ${(e as Error).message}` }
      }
    }
    const requestId = newRequestId()
    return new Promise<unknown>(resolve => {
      const timer = setTimeout(
        () => settle(requestId, { error: `${call.name} timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      pending.set(requestId, { settle: resolve, timer })
      try {
        opts.send('voice_tool_call', { requestId, name: call.name, args: call.args })
      } catch (e) {
        settle(requestId, { error: `could not reach the broker: ${(e as Error).message}` })
      }
    })
  }

  function deliver(msg: ToolResultMessage): void {
    if (!msg.requestId) return
    settle(msg.requestId, msg.ok ? msg.result : { error: msg.error ?? 'tool failed' })
  }

  function dispose(): void {
    for (const requestId of [...pending.keys()]) settle(requestId, { error: 'voice session closed' })
  }

  return { run, deliver, dispose }
}

// ─── The live bridge, for the WS handler table ─────────────────────────
// One orb at a time (it is a single global summonable surface), so a module
// slot is enough -- the alternative is threading a ref through the whole
// websocket handler table for one message type.

let activeBridge: ToolBridge | null = null

export function setActiveToolBridge(bridge: ToolBridge | null): void {
  activeBridge = bridge
}

/** Route a `voice_tool_call_result` to the live bridge. No-op when the orb is
 *  not summoned (a late reply after teardown). */
export function deliverVoiceToolResult(msg: ToolResultMessage): void {
  activeBridge?.deliver(msg)
}

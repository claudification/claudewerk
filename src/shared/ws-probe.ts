/**
 * THE WS ROUND-TRIP PROBE -- the one application-level echo on the dashboard socket.
 *
 * There was no round trip measurable from the browser before this. `ws-stats.ts`
 * counts messages and bytes (THROUGHPUT), and the only correlated request ->
 * response pairs on this wire (`send_input` -> `send_input_result`,
 * `channel_subscribe` -> `channel_ack`) fire on human action or on subscribe,
 * never on a cadence. So P4's socket tile showed a dash where the latency
 * belonged. This is the pair that fills it.
 *
 * DELIBERATELY THE SMALLEST THING THAT WORKS: the client sends an opaque token,
 * the broker sends it straight back, and the client subtracts. The broker holds
 * NO state for it -- no per-socket timer, no pending map, nothing to leak when a
 * panel dies mid-probe. A pong the client no longer recognizes is simply
 * dropped.
 *
 * NOT a liveness/keepalive mechanism. The WebSocket protocol has its own
 * ping/pong frames for that and they are invisible to browser JS, which is
 * exactly why this exists at the application layer instead. Nothing in the
 * broker treats a missing `ws_ping` as a dead socket.
 *
 * Constants rather than bare literals because four places must agree on the two
 * strings: the broker handler that registers `ws_ping`, its registration in the
 * dashboard role group, the client probe that emits it, and the client bypass
 * that routes `ws_pong` around the rAF buffer.
 */

/** Client -> broker. Carries an opaque token and nothing else. */
export const WS_PING = 'ws_ping'

/** Broker -> client. The same token, echoed verbatim. */
export const WS_PONG = 'ws_pong'

export interface WsPingMessage {
  type: typeof WS_PING
  /** Opaque to the broker. The client uses it to match a pong to its send time. */
  token: string
}

export interface WsPongMessage {
  type: typeof WS_PONG
  token: string
}

/**
 * A pong is only useful if its token round-trips intact, so the broker echoes
 * strings and refuses everything else. A number, an object, or a 10 KB string
 * would all "work" as a correlation key; none of them are worth the surface.
 */
export const WS_PROBE_TOKEN_MAX = 64

export function isValidProbeToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= WS_PROBE_TOKEN_MAX
}

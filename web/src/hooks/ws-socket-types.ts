/**
 * The shapes the dashboard socket's pieces pass between each other.
 *
 * Kept in a leaf module on purpose: the connection, the router, the handshake
 * and the subscription watchers all need them, and importing the type from any
 * one of those would make the graph a ring.
 *
 * The refs are structural rather than React's `RefObject` so a module that only
 * mutates `.current` does not have to import React to say so.
 */

/** Serialize-and-send on the live socket. Drops the message when it is not open. */
export type WsSend = (msg: Record<string, unknown>) => void

/** The hook's `wsRef`: the socket for this mount, or null between connections. */
export type SocketRef = { current: WebSocket | null }

/** The hook's `reconnectTimeoutRef`: a pending reconnect, or null when none is armed. */
export type TimerRef = { current: ReturnType<typeof setTimeout> | null }

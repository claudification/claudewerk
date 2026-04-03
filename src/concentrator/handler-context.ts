/**
 * Handler context: passed to every WS message handler.
 * Provides access to session state, utilities, and the calling connection.
 */

import type { ServerWebSocket } from 'bun'
import type { ProjectSettings } from '../shared/protocol'
import type { SessionStore } from './session-store'

export interface WsData {
  sessionId?: string
  wrapperId?: string
  isDashboard?: boolean
  isAgent?: boolean
  userName?: string
  authToken?: string
}

/** Thrown by guard methods (requireBenevolent, requireAgent, etc.) */
export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export interface HandlerContext {
  /** The WebSocket connection that sent this message */
  ws: ServerWebSocket<WsData>
  /** Session store (read/write session state) */
  sessions: SessionStore
  /** Resolved caller session (from ws.data.sessionId) */
  caller?: ReturnType<SessionStore['getSession']>
  /** Caller's project settings */
  callerSettings?: ProjectSettings | null
  /** Verbose logging flag */
  verbose: boolean

  /** Send a JSON response back to the caller */
  reply(msg: Record<string, unknown>): void
  /** Broadcast a JSON message to all dashboard subscribers */
  broadcast(msg: Record<string, unknown>): void
  /** Web push notifications */
  push: {
    configured: boolean
    sendToAll(title: string, body: string): void
  }
  /** WebAuthn origins (for meta ack) */
  origins: string[]
  /** Get the host agent WebSocket (if connected) */
  getAgent(): ServerWebSocket<unknown> | undefined
  /** Get persisted links for a CWD */
  getLinksForCwd(cwd: string): Array<{ cwdA: string; cwdB: string }>
  /** Get project settings for a CWD */
  getProjectSettings(cwd: string): ProjectSettings | null
  /** Set project settings for a CWD */
  setProjectSettings(cwd: string, update: Partial<ProjectSettings>): void
  /** Get all project settings */
  getAllProjectSettings(): Record<string, ProjectSettings>

  /** Contextual logger -- auto-prefixes with session/wrapper info */
  log: {
    info(msg: string): void
    error(msg: string, err?: unknown): void
    debug(msg: string): void
  }

  /** Guard: throws GuardError if caller is not benevolent */
  requireBenevolent(): void
  /** Guard: throws GuardError if no host agent connected */
  requireAgent(): ServerWebSocket<unknown>
  /** Guard: throws GuardError if caller has no session */
  requireSession(): NonNullable<ReturnType<SessionStore['getSession']>>
}

export type MessageHandler = (ctx: HandlerContext, data: Record<string, unknown>) => void

/** Create a log prefix from WS connection data */
export function logPrefix(ws: { data: WsData }): string {
  const id = ws.data.sessionId?.slice(0, 8)
  if (ws.data.isAgent) return '[agent]'
  if (ws.data.isDashboard) return `[dash${ws.data.userName ? `:${ws.data.userName}` : ''}]`
  return id ? `[${id}]` : '[unknown]'
}

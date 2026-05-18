/**
 * cli-args.ts -- environment-variable config parser for daemon-agent-host.
 *
 * The daemon-agent-host attaches to a Claude Code daemon worker (cc-daemon)
 * instead of spawning a fresh CLI process. This file reads the process
 * environment and returns a typed config object; any missing required value
 * writes a FATAL message to stderr and exits immediately.
 *
 * Env vars (set by the sentinel or spawner):
 *   CLAUDWERK_BROKER          broker WebSocket URL (fallback: RCLAUDE_BROKER,
 *                             then the compiled-in DEFAULT_BROKER_URL)
 *   CLAUDWERK_SECRET          broker auth token (fallback: RCLAUDE_SECRET;
 *                             may be undefined -- that is valid for local dev)
 *   RCLAUDE_CONVERSATION_ID   stable conversation id (REQUIRED)
 *   CLAUDWERK_DAEMON_SHORT    short id of the cc-daemon worker to attach
 *                             (REQUIRED -- uniquely identifies the target worker)
 *   RCLAUDE_CWD               working directory override (fallback: process.cwd())
 */

import { DEFAULT_BROKER_URL } from '../shared/protocol'

const log = (msg: string): void => { process.stderr.write(`[daemon-host] ${msg}\n`) }

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonHostConfig {
  brokerUrl: string
  brokerSecret: string | undefined
  conversationId: string
  daemonShort: string
  cwd: string
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseDaemonHostConfig(): DaemonHostConfig {
  const brokerUrl =
    process.env.CLAUDWERK_BROKER || process.env.RCLAUDE_BROKER || DEFAULT_BROKER_URL

  const brokerSecret = process.env.CLAUDWERK_SECRET || process.env.RCLAUDE_SECRET

  const conversationId = process.env.RCLAUDE_CONVERSATION_ID
  if (!conversationId) {
    log('FATAL: RCLAUDE_CONVERSATION_ID is required')
    process.exit(1)
  }

  const daemonShort = process.env.CLAUDWERK_DAEMON_SHORT
  if (!daemonShort) {
    log('FATAL: CLAUDWERK_DAEMON_SHORT is required')
    process.exit(1)
  }

  const cwd = process.env.RCLAUDE_CWD || process.cwd()

  return {
    brokerUrl,
    brokerSecret,
    conversationId,
    daemonShort,
    cwd,
  }
}

/**
 * cli-args.ts -- environment-variable config parser for daemon-agent-host.
 *
 * The daemon-agent-host attaches to a Claude Code daemon worker (cc-daemon)
 * instead of spawning a fresh CLI process. This file reads the process
 * environment and returns a typed config object.
 *
 * Resolution is split in two: `resolveDaemonHostConfig(env)` is a PURE function
 * (no `process.exit`, fully unit-testable) returning a result discriminated by
 * `ok`; `parseDaemonHostConfig()` is the thin wrapper that calls it against
 * `process.env`, logs a FATAL line and exits on a bad config.
 *
 * Launch modes (`CLAUDWERK_DAEMON_MODE`, default `new`):
 *   new     the sentinel ran `claude --bg "<prompt>"`; SHORT is the captured id.
 *   resume  the sentinel ran `claude --bg --resume <RESUME_SESSION>`; SHORT is
 *           the FRESH captured id (the resumed worker forks to a new ccSession,
 *           so RESUME_SESSION is the resume INPUT, not the live worker id).
 *   attach  the sentinel resolved SHORT from the daemon roster -- no dispatch.
 *
 * Env vars (set by the sentinel or spawner):
 *   CLAUDWERK_BROKER             broker WebSocket URL (fallback: RCLAUDE_BROKER,
 *                                then the compiled-in DEFAULT_BROKER_URL)
 *   CLAUDWERK_SECRET             broker auth token (fallback: RCLAUDE_SECRET;
 *                                may be undefined -- that is valid for local dev)
 *   RCLAUDE_CONVERSATION_ID      stable conversation id (REQUIRED)
 *   CLAUDWERK_DAEMON_SHORT       short id of the cc-daemon worker to attach
 *                                (REQUIRED in every mode -- uniquely identifies
 *                                the target worker)
 *   CLAUDWERK_DAEMON_MODE        new | resume | attach (default: new)
 *   CLAUDWERK_DAEMON_RESUME_SESSION  daemon session id passed to
 *                                `claude --bg --resume` (REQUIRED when mode is
 *                                `resume`; ignored otherwise)
 *   RCLAUDE_CWD                  working directory override (fallback: process.cwd())
 */

import { DEFAULT_BROKER_URL } from '../shared/protocol'

const log = (msg: string): void => {
  process.stderr.write(`[daemon-host] ${msg}\n`)
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How this daemon-agent-host obtained the worker it hosts. */
export type DaemonMode = 'new' | 'resume' | 'attach'

const DAEMON_MODES: readonly DaemonMode[] = ['new', 'resume', 'attach']

export interface DaemonHostConfig {
  brokerUrl: string
  brokerSecret: string | undefined
  conversationId: string
  daemonShort: string
  cwd: string
  /** Launch mode -- decides how the session observer derives the initial id. */
  mode: DaemonMode
  /**
   * The daemon session id that was passed to `claude --bg --resume`. Set only
   * when `mode === 'resume'`. This is the resume INPUT: the resumed worker
   * forks to a brand-new ccSessionId (spike finding 1), so this is NOT the
   * live worker id -- it is kept for diagnostics / launch-event detail only.
   */
  resumeSessionId: string | undefined
}

/** Result of the pure config resolver -- success or a human-readable reason. */
export type DaemonHostConfigResult = { ok: true; config: DaemonHostConfig } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Pure resolver (no process.exit -- unit-testable)
// ---------------------------------------------------------------------------

/** Resolve the broker target with the CLAUDWERK_ >> RCLAUDE_ precedence. */
function resolveBrokerTarget(env: NodeJS.ProcessEnv): {
  brokerUrl: string
  brokerSecret: string | undefined
} {
  return {
    brokerUrl: env.CLAUDWERK_BROKER || env.RCLAUDE_BROKER || DEFAULT_BROKER_URL,
    brokerSecret: env.CLAUDWERK_SECRET || env.RCLAUDE_SECRET,
  }
}

/** Validate `CLAUDWERK_DAEMON_MODE`, defaulting to `new`. */
function parseDaemonMode(raw: string | undefined): { mode: DaemonMode } | { error: string } {
  const mode = (raw ? raw : 'new') as DaemonMode
  if (!DAEMON_MODES.includes(mode)) {
    return { error: `CLAUDWERK_DAEMON_MODE must be one of new|resume|attach (got "${raw}")` }
  }
  return { mode }
}

/**
 * Resolve a `DaemonHostConfig` from an environment map. Pure: never exits,
 * never logs -- every failure path returns `{ ok: false, error }`.
 */
export function resolveDaemonHostConfig(env: NodeJS.ProcessEnv = process.env): DaemonHostConfigResult {
  const conversationId = env.RCLAUDE_CONVERSATION_ID
  if (!conversationId) {
    return { ok: false, error: 'RCLAUDE_CONVERSATION_ID is required' }
  }

  const parsedMode = parseDaemonMode(env.CLAUDWERK_DAEMON_MODE)
  if ('error' in parsedMode) return { ok: false, error: parsedMode.error }
  const { mode } = parsedMode

  // SHORT identifies the worker in every mode: new/resume capture it from
  // `claude --bg`, attach resolves it from the roster. No fallback exists.
  const daemonShort = env.CLAUDWERK_DAEMON_SHORT
  if (!daemonShort) {
    return { ok: false, error: `CLAUDWERK_DAEMON_SHORT is required (mode=${mode})` }
  }

  const resumeSessionId = env.CLAUDWERK_DAEMON_RESUME_SESSION
  if (mode === 'resume' && !resumeSessionId) {
    return { ok: false, error: 'CLAUDWERK_DAEMON_RESUME_SESSION is required when CLAUDWERK_DAEMON_MODE=resume' }
  }

  return {
    ok: true,
    config: {
      ...resolveBrokerTarget(env),
      conversationId,
      daemonShort,
      cwd: env.RCLAUDE_CWD || process.cwd(),
      mode,
      resumeSessionId: mode === 'resume' ? resumeSessionId : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Process entrypoint wrapper
// ---------------------------------------------------------------------------

/** Resolve config from `process.env`; log a FATAL line and exit on a bad config. */
export function parseDaemonHostConfig(): DaemonHostConfig {
  const result = resolveDaemonHostConfig(process.env)
  if (!result.ok) {
    log(`FATAL: ${result.error}`)
    process.exit(1)
  }
  return result.config
}

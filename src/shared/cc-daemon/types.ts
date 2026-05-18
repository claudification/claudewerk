/**
 * Wire types for the Claude Code background-session daemon (`claude daemon`)
 * control socket. Reverse-engineered from the 2.1.143 binary and live-verified
 * against a running daemon -- see `.claude/docs/plan-claude-agents-integration.md`.
 *
 * THIS MODULE IS THE PROTO-FRAGILE SURFACE. The daemon stamps every frame with a
 * `proto` version and hard-rejects mismatches on gated ops with EPROTO. When
 * Claude Code bumps the protocol this module must break loudly -- by design.
 */

/** Control-socket wire-protocol version. Verified: proto 1 on CC 2.1.143. */
export const CC_DAEMON_PROTO = 1

/**
 * Error codes the daemon returns in `{ ok: false, code }`. The full set
 * recovered from the 2.1.143 binary -- `ENOREPLY` / `EUNVERIFIED` / `EALIVE` /
 * `ESTALE` surface from the mutating + attach ops.
 */
export type DaemonErrorCode =
  | 'EPROTO'
  | 'ENOJOB'
  | 'ENOCONN'
  | 'ETIMEOUT'
  | 'ESTARTING'
  | 'ERESPAWNING'
  | 'ETOOLARGE'
  | 'EPEERUID'
  | 'EKICKED'
  | 'ESTALLED'
  | 'ENOREPLY'
  | 'EUNVERIFIED'
  | 'EALIVE'
  | 'ESTALE'
  | 'EUNKNOWN'

/** A request to the control socket. `proto` is stamped by the client. */
export interface ControlRequest {
  op: string
  [field: string]: unknown
}

/** A successful response: `{ ok: true, op, ... }`. */
export interface DaemonOk {
  ok: true
  op: string
  [field: string]: unknown
}

/** A failure response: `{ ok: false, error, code? }`. */
export interface DaemonErr {
  ok: false
  error: string
  code?: DaemonErrorCode
}

export type DaemonResponse = DaemonOk | DaemonErr

/**
 * Compact job record returned inline by `list` and by the `subscribe` snapshot.
 * A subset of the on-disk `~/.claude/jobs/<id>/state.json`.
 */
export interface JobRecord {
  short: string
  sessionId: string
  cwd: string
  state: string
  nonce?: string
  pid?: number
  attempt?: number
  startedAt?: number
  backend?: string
  tempo?: string
  detail?: string
  intent?: string
  name?: string
  cliVersion?: string
  source?: string
  needs?: string
}

/** Response shape of the `list` op. */
export interface ListResponse extends DaemonOk {
  op: 'list'
  jobs: JobRecord[]
}

/**
 * Attacher capabilities, sent in the `attach` request. Live-verified: when
 * `caps` is present the daemon REQUIRES `terminal`, `mux` and `ssh`; the rest
 * are optional. Recovered from the 2.1.143 `attach` request schema.
 */
export interface AttachCaps {
  /** Terminal type (e.g. `xterm-256color`), or null if unknown. */
  terminal: string | null
  /** Terminal multiplexer the attacher runs inside, or null. */
  mux: 'tmux' | 'screen' | 'zellij' | null
  /** Whether the attacher is reached over SSH. */
  ssh: boolean
  wheelFlood?: boolean
  hyperlinks?: boolean
  progressReporting?: boolean
  wtSession?: boolean
  isVscodeTerm?: boolean
  browser?: string | null
  colorLevel?: 0 | 1 | 2 | 3
  editor?: string | null
}

/**
 * Successful `attach` ack on the control socket. The daemon answers the attach
 * request with this newline-JSON frame, then -- on the same connection --
 * streams raw PTY bytes. The clean framed duplex lives on the worker `ptySock`.
 */
export interface AttachAck extends DaemonOk {
  op: 'attach'
  /** DEC private mode numbers the worker terminal has enabled. */
  decModes: number[]
  /** Provenance of the worker PTY (e.g. `spare`). */
  via: string
  /** Coarse activity tempo at attach time. */
  tempo: string
  /** Job state at attach time (see the `state` vocab). */
  state: string
}

// The socket `dispatch` op's `DispatchSpec` (`nJ6` in the 2.1.143 binary) is a
// Phase 3 concern -- Phase 2 dispatches workers via `claude --bg`. The full
// recovered schema is documented in plan-claude-agents-integration.md section
// 13; the typed `DispatchSpec` interface lands when the `dispatch` op is built.

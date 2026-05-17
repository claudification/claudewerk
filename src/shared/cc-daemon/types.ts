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

/** Error codes the daemon returns in `{ ok: false, code }`. */
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

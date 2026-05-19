/**
 * attach-retry -- a thin retry wrapper around the cc-daemon `attach` op.
 *
 * `claude --bg` dispatches a worker, but the daemon-host's `attach` can still
 * race the worker's boot and get back `ESTARTING` (worker still starting) or
 * `ENOJOB` (the daemon has not registered the job yet). Both are transient:
 * retry with a fixed backoff.
 *
 * `EPROTO` (a Claude Code protocol bump) is NEVER retried -- it surfaces as a
 * `ProtocolMismatchError` and means claudewerk needs a binary update. Any other
 * failure (socket error, connect timeout, EKICKED, ...) is also thrown
 * immediately -- only ESTARTING/ENOJOB are genuinely transient.
 *
 * Spike finding 3 (plan-daemon-launch-ux.md section 8): `claude --bg` blocks
 * ~880ms and the worker is attachable the instant it returns, so in the
 * NEW/RESUME flow this retry essentially never fires. It is a cheap safety net
 * for the rare race, and for the re-attach-after-drop path which does not wait
 * on a `claude --bg` call. maxAttempts=10 / delayMs=500 is ample.
 */
import { type AttachHandle, type AttachOptions, attach, DaemonAttachError } from '../shared/cc-daemon/attach'
import { ProtocolMismatchError } from '../shared/cc-daemon/client'

/** Daemon error codes worth retrying -- the worker is booting / not yet registered. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['ESTARTING', 'ENOJOB'])

const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_DELAY_MS = 500

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The daemon error code an attach failure carries, if any. */
function attachErrorCode(err: unknown): string | undefined {
  return err instanceof DaemonAttachError ? err.code : undefined
}

/**
 * Whether an attach failure is worth retrying. `EPROTO` (a protocol bump) and
 * every non-transient code are NOT retryable -- only a worker still booting
 * (`ESTARTING`) or not yet registered (`ENOJOB`).
 */
function isRetryableAttachError(err: unknown): boolean {
  if (err instanceof ProtocolMismatchError) return false
  const code = attachErrorCode(err)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

export interface AttachWithRetryOptions {
  /** Maximum attach attempts before giving up. Default 10. */
  maxAttempts?: number
  /** Delay between attempts, in ms. Default 500. */
  delayMs?: number
  /**
   * Fired before each retry sleep -- lets the caller emit a structured boot
   * event. `code` is the daemon error code that triggered the retry.
   */
  onRetry?: (attempt: number, maxAttempts: number, code: string | undefined) => void
  /** Test seam: the attach implementation. Defaults to the real cc-daemon `attach`. */
  attachFn?: typeof attach
}

/**
 * Attach to daemon worker `short`, retrying transient ESTARTING/ENOJOB failures.
 *
 * Resolves with the live `AttachHandle`; rejects with the last error once the
 * attempts are exhausted, or immediately on a non-transient failure
 * (`ProtocolMismatchError`, socket error, EKICKED, ...).
 *
 * The caller's `onClose` / `onError` handlers are wired ONLY to the successful
 * handle -- a failed attempt's close/error events are swallowed so a retry is
 * not mistaken for a real session drop.
 */
export async function attachWithRetry(
  controlSock: string,
  short: string,
  attachOpts: AttachOptions,
  opts: AttachWithRetryOptions = {},
): Promise<AttachHandle> {
  const attachFn = opts.attachFn ?? attach
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Suppress close/error events until THIS attempt has resolved a handle --
    // a pre-ack failure must not look like a live session dropping.
    let succeeded = false
    try {
      const handle = await attachFn(controlSock, short, {
        ...attachOpts,
        onClose: reason => {
          if (succeeded) attachOpts.onClose?.(reason)
        },
        onError: err => {
          if (succeeded) attachOpts.onError?.(err)
        },
      })
      succeeded = true
      return handle
    } catch (err) {
      if (!isRetryableAttachError(err) || attempt === maxAttempts) throw err
      opts.onRetry?.(attempt, maxAttempts, attachErrorCode(err))
      await sleep(delayMs)
    }
  }
  // Unreachable: every loop iteration either returns or throws.
  throw new Error('attachWithRetry: attempts exhausted')
}

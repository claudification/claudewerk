/**
 * launch-smoke -- the testable fixture layer for the cc-daemon launch smoke
 * harness (`scripts/cc-daemon-launch-smoke.ts`, plan-daemon-launch-ux.md
 * Section 6.2 / Phase H).
 *
 * The harness drives a real Claude Code daemon through NEW / RESUME / ATTACH
 * and asserts the worker transcript mirrors through. This module holds the
 * parts that have no live dependency, so they can be unit-tested under
 * `bun:test` without a daemon: the in-memory broker, the version canary, the
 * `claude --bg` short parser, the cleanup registry, the assertion helpers and
 * the verbose step logger. The live orchestration lives in
 * `launch-smoke-mirror.ts`; the runnable entrypoint in `scripts/`.
 *
 * BOUNDARY RULE: the in-memory broker stores every host message OPAQUELY. It
 * never reads `ccSessionId` off any of them and `setSessionId()` is a no-op --
 * a broker (even a fake one) never interprets a CC session id. The harness
 * itself derives the ccSessionId from the session observer, not from here.
 */

import { rmSync } from 'node:fs'
import { CC_DAEMON_PROTO, type DaemonResponse } from '../shared/cc-daemon/types'
import type { HostTransport } from '../shared/host-transport'
import type { AgentHostMessage, TranscriptEntries, TranscriptEntry } from '../shared/protocol'

// ---------------------------------------------------------------------------
// Verbose step logger -- the harness output IS the diagnostic signal, so every
// step is timestamped (LOG EVERYTHING covenant: a red canary is read here).
// ---------------------------------------------------------------------------

export interface SmokeLogger {
  /** A top-level phase boundary. */
  step(msg: string): void
  /** An indented sub-step detail. */
  detail(msg: string): void
  /** A passed assertion. */
  ok(msg: string): void
  /** A failed assertion / fatal condition. */
  fail(msg: string): void
}

/** Create a logger. `write` is injectable so tests can capture the output. */
export function createSmokeLogger(
  write: (line: string) => void = line => void process.stderr.write(line),
): SmokeLogger {
  const t0 = Date.now()
  const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
  const emit = (mark: string, msg: string): void => write(`[smoke ${stamp()}] ${mark} ${msg}\n`)
  return {
    step: msg => emit('>>', msg),
    detail: msg => emit('  ', msg),
    ok: msg => emit('OK', msg),
    fail: msg => emit('FAIL', msg),
  }
}

// ---------------------------------------------------------------------------
// Generic poll-until -- the basis of every "wait for X" in the harness.
// ---------------------------------------------------------------------------

export interface WaitUntilOptions {
  /** Give up after this many ms. Default 30s. */
  timeoutMs?: number
  /** Poll cadence. Default 100ms. */
  intervalMs?: number
  /** Human label for the timeout error. */
  label?: string
}

/** Poll `probe` until it returns a non-nullish value, or throw on timeout. */
export async function waitUntil<T>(
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  opts: WaitUntilOptions = {},
): Promise<T> {
  const { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = opts
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await probe()
    if (hit != null) return hit
    if (Date.now() >= deadline) throw new Error(`smoke: timed out after ${timeoutMs}ms waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// In-memory broker -- a HostTransport that records messages instead of sending
// them over a WebSocket. The transcript bridge + mirror orchestration send
// through this; the harness asserts against what landed.
// ---------------------------------------------------------------------------

export interface InMemoryBroker {
  /** The HostTransport the transcript bridge / orchestration sends through. */
  readonly transport: HostTransport
  /** Every message the host sent, in order (stored opaquely). */
  messages(): readonly AgentHostMessage[]
  /** Flattened transcript entries from every `transcript_entries` message. */
  transcriptEntries(): TranscriptEntry[]
  /** Number of `transcript_entries` batches received (sequencing assertions). */
  batchCount(): number
  /** Resolve once a transcript entry matches `predicate`; throw on timeout. */
  waitForTranscript(predicate: (entry: TranscriptEntry) => boolean, opts?: WaitUntilOptions): Promise<TranscriptEntry>
}

/** Stand up an in-memory broker for one conversation. */
export function createInMemoryBroker(conversationId: string): InMemoryBroker {
  const log: AgentHostMessage[] = []

  const transport: HostTransport = {
    send: msg => void log.push(msg),
    sendTranscriptEntries: (entries, isInitial) => {
      const msg: TranscriptEntries = { type: 'transcript_entries', conversationId, entries, isInitial }
      log.push(msg)
    },
    // Boundary rule: a broker never reads / branches on a CC session id.
    setSessionId: () => {},
    close: () => {},
    isConnected: () => true,
    flush: () => {},
  }

  const transcriptEntries = (): TranscriptEntry[] =>
    log.filter((m): m is TranscriptEntries => m.type === 'transcript_entries').flatMap(m => m.entries)

  return {
    transport,
    messages: () => log,
    transcriptEntries,
    batchCount: () => log.filter(m => m.type === 'transcript_entries').length,
    waitForTranscript: (predicate, opts) =>
      waitUntil(() => transcriptEntries().find(predicate), { label: 'transcript entry', ...opts }),
  }
}

// ---------------------------------------------------------------------------
// Version canary -- a CC daemon-protocol bump must FAIL the harness LOUD.
// ---------------------------------------------------------------------------

export interface CanaryResult {
  /** True when the daemon protocol matches what claudewerk expects. */
  ok: boolean
  /** Daemon-reported control-protocol version, or null if not echoed. */
  proto: number | null
  /** Daemon-reported CC version string, or null if not echoed. */
  version: string | null
  /** Loud failure message when `ok` is false. */
  error?: string
  /** Non-fatal note (e.g. the daemon did not echo `proto`). */
  note?: string
}

/** Note surfaced when the daemon ping omits `proto` -- the gated ops still catch a bump. */
const PROTO_ABSENT_NOTE = 'daemon ping did not echo `proto`; relying on gated-op EPROTO as the canary'

/** Pull the `proto` / `version` fields off a successful ping frame. */
function readPingFrame(resp: DaemonResponse): { proto: number | null; version: string | null } {
  const frame = resp as Record<string, unknown>
  return {
    proto: typeof frame.proto === 'number' ? frame.proto : null,
    version: typeof frame.version === 'string' ? frame.version : null,
  }
}

/** Evaluate a `ping` response against the expected daemon protocol version. */
export function checkVersionCanary(resp: DaemonResponse): CanaryResult {
  if (resp.ok === false) {
    const code = resp.code ? ` (${resp.code})` : ''
    return { ok: false, proto: null, version: null, error: `daemon ping failed: ${resp.error}${code}` }
  }
  const { proto, version } = readPingFrame(resp)
  if (proto !== null && proto !== CC_DAEMON_PROTO) {
    return {
      ok: false,
      proto,
      version,
      error:
        `Claude Code bumped the daemon control protocol (daemon proto=${proto}, ` +
        `claudewerk expects ${CC_DAEMON_PROTO}) -- claudewerk needs an update before daemon launch works`,
    }
  }
  return { ok: true, proto, version, note: proto === null ? PROTO_ABSENT_NOTE : undefined }
}

// ---------------------------------------------------------------------------
// `claude --bg` short-id parsing.
// ---------------------------------------------------------------------------

/** Strip ANSI escapes so the `backgrounded - <id>` line can be matched. */
const ANSI_RE = /\[[0-9;]*m/g

/** Extract the 8-hex worker short id from `claude --bg` output, or null. */
export function parseBackgroundShort(output: string): string | null {
  const match = output.replace(ANSI_RE, '').match(/backgrounded\s+\W+\s*([0-9a-f]{8})/)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Transcript assertion helpers.
// ---------------------------------------------------------------------------

/** Text strings carried by a transcript entry's `message.content` (string or block array). */
function textBlocksOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    const typed = block as { type?: string; text?: string }
    if (typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
  }
  return texts
}

/** Every assistant-authored text string across `entries`. */
export function assistantTextOf(entries: TranscriptEntry[]): string[] {
  const texts: string[] = []
  for (const entry of entries) {
    if ((entry as { type?: string }).type !== 'assistant') continue
    const content = (entry as { message?: { content?: unknown } }).message?.content
    texts.push(...textBlocksOf(content))
  }
  return texts
}

/** True when any assistant text in `entries` contains `needle`. */
export function transcriptContainsText(entries: TranscriptEntry[], needle: string): boolean {
  return assistantTextOf(entries).some(text => text.includes(needle))
}

/** Distinct, order-preserving, non-empty job states from a sample list. */
export function distinctStatesFrom(samples: ReadonlyArray<string | null | undefined>): string[] {
  const seen: string[] = []
  for (const sample of samples) {
    if (sample && !seen.includes(sample)) seen.push(sample)
  }
  return seen
}

// ---------------------------------------------------------------------------
// Cleanup registry -- every probe job + temp dir is tracked and torn down,
// pass or fail. A leaked `claude --bg` worker keeps billing the subscription.
// ---------------------------------------------------------------------------

export interface CleanupSummary {
  jobsRemoved: number
  jobsFailed: number
  dirsRemoved: number
}

export interface CleanupDeps {
  /** Remove one probe job (e.g. `claude rm <short>`). */
  removeJob: (short: string) => Promise<void>
  /** Optional progress log. */
  log?: (msg: string) => void
}

export interface CleanupRegistry {
  /** Track a dispatched probe worker short id. */
  trackJob(short: string): void
  /** Track a temp cwd to remove. */
  trackTempDir(dir: string): void
  jobs(): string[]
  tempDirs(): string[]
  /** Remove every tracked job + dir. Never throws -- failures are counted. */
  run(deps: CleanupDeps): Promise<CleanupSummary>
}

/** Remove one tracked probe job, folding the outcome into `summary`. Never throws. */
async function removeTrackedJob(deps: CleanupDeps, short: string, summary: CleanupSummary): Promise<void> {
  try {
    await deps.removeJob(short)
    summary.jobsRemoved++
    deps.log?.(`removed probe job ${short}`)
  } catch (err) {
    summary.jobsFailed++
    deps.log?.(`FAILED to remove probe job ${short}: ${(err as Error).message}`)
  }
}

/** Remove one tracked temp dir, folding the outcome into `summary`. Never throws. */
function removeTrackedDir(deps: CleanupDeps, dir: string, summary: CleanupSummary): void {
  try {
    rmSync(dir, { recursive: true, force: true })
    summary.dirsRemoved++
    deps.log?.(`removed temp dir ${dir}`)
  } catch (err) {
    deps.log?.(`FAILED to remove temp dir ${dir}: ${(err as Error).message}`)
  }
}

/** Create an empty cleanup registry. */
export function createCleanupRegistry(): CleanupRegistry {
  const jobs = new Set<string>()
  const dirs = new Set<string>()

  async function run(deps: CleanupDeps): Promise<CleanupSummary> {
    const summary: CleanupSummary = { jobsRemoved: 0, jobsFailed: 0, dirsRemoved: 0 }
    for (const short of jobs) await removeTrackedJob(deps, short, summary)
    for (const dir of dirs) removeTrackedDir(deps, dir, summary)
    return summary
  }

  return {
    trackJob: short => void jobs.add(short),
    trackTempDir: dir => void dirs.add(dir),
    jobs: () => [...jobs],
    tempDirs: () => [...dirs],
    run,
  }
}

#!/usr/bin/env bun
/**
 * cc-daemon cost-measurement spike (plan-claude-agents-integration.md section 10).
 *
 * Measures how many tokens a trivial `claude --bg` probe turn consumes under
 * three context configs, to pick the cheapest viable Tier-2 smoke-test setup:
 *
 *   A "full-context" -- cwd = repo root: global + project CLAUDE.md, MEMORY.md,
 *                        skills all load.
 *   B "bare-cwd"     -- cwd = a fresh empty temp dir: no project CLAUDE.md;
 *                        global config still loads.
 *   C "bare-flag"    -- cwd = a fresh empty temp dir + `--bare`: skips hooks,
 *                        auto-memory and CLAUDE.md auto-discovery. `--bare`
 *                        reads auth strictly from ANTHROPIC_API_KEY / apiKeyHelper
 *                        (NOT keychain/OAuth) -- without one it fails to auth;
 *                        the harness detects that and reports it gracefully.
 *
 * Dogfoods the Phase 1 cc-daemon module: `resolveControlSocket()` to find the
 * control socket and `list()` to poll job state. Each probe job is dispatched
 * with a unique `--name`, polled to a terminal state, measured from its
 * transcript JSONL, then removed with `claude rm` -- only ever the jobs this
 * harness itself dispatched.
 *
 * Disposable spike. Re-run with `bun scripts/cc-daemon-cost-spike.ts`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { list } from '../src/shared/cc-daemon/ops'
import { resolveControlSocket } from '../src/shared/cc-daemon/socket-path'
import type { JobRecord } from '../src/shared/cc-daemon/types'

const HAIKU = 'claude-haiku-4-5-20251001'
const PROMPT = 'Reply with exactly: PROBE-OK and nothing else.'
const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 120_000
const TERMINAL_STATES = new Set(['done', 'failed', 'stopped', 'crashed'])

/** One probe configuration: where to run and whether to pass `--bare`. */
interface ProbeConfig {
  config: string
  cwd: string
  bare: boolean
}

/** Summed transcript token usage for one probe job. */
interface Usage {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  assistantMsgs: number
}

type ProbeStatus = 'measured' | 'dispatch-failed' | 'auth-failed' | 'timeout' | 'no-transcript'

/** Outcome of measuring one probe. */
interface ProbeResult {
  config: string
  short?: string
  status: ProbeStatus
  finalState?: string
  note?: string
  usage?: Usage
}

/** Progress logging -- stderr, so stdout carries only the final report. */
function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/** Resolve a Promise after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Clip a string for safe inclusion in a note. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

/** Strip ANSI escape sequences so the job id can be matched in plain text. */
const ANSI_RE = /\[[0-9;]*m/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/**
 * The main repo root -- Probe A's "full-context" cwd. When the harness runs
 * from a worktree the real project context lives in the main checkout, so we
 * slice the path at the `.claude/worktrees/` marker; outside a worktree the
 * repo root is simply the parent of `scripts/`.
 */
function mainRepoRoot(): string {
  const dir = import.meta.dir
  const marker = '/.claude/worktrees/'
  const idx = dir.indexOf(marker)
  return idx >= 0 ? dir.slice(0, idx) : join(dir, '..')
}

/** The three probe configs, in report order. */
function buildConfigs(bareCwdDir: string, bareFlagDir: string): ProbeConfig[] {
  return [
    { config: 'full-context', cwd: mainRepoRoot(), bare: false },
    { config: 'bare-cwd', cwd: bareCwdDir, bare: false },
    { config: 'bare-flag', cwd: bareFlagDir, bare: true },
  ]
}

/** `claude --bg` argv for a probe, with a unique job name. */
function probeArgs(cfg: ProbeConfig, name: string): string[] {
  const args = ['claude', '--bg']
  if (cfg.bare) args.push('--bare')
  args.push('--model', HAIKU, '--name', name, PROMPT)
  return args
}

/** Extract the 8-hex job short id from `claude --bg` output (`backgrounded · <id>`). */
function parseShort(output: string): string | null {
  const match = stripAnsi(output).match(/backgrounded\s+\W+\s*([0-9a-f]{8})/)
  return match ? match[1] : null
}

/**
 * Dispatch one probe job. Returns the captured short id (or null if `claude`
 * printed no job id -- e.g. an incompatible flag) plus the combined output.
 */
async function dispatchProbe(cfg: ProbeConfig, name: string): Promise<{ short: string | null; output: string }> {
  const proc = Bun.spawn(probeArgs(cfg, name), {
    cwd: cfg.cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const output = `${out}${err}`.trim()
  return { short: parseShort(output), output }
}

/** Look up one job by short id in the current daemon `list`. */
async function findJob(sockPath: string, short: string): Promise<JobRecord | null> {
  const resp = await list(sockPath)
  return resp.jobs.find(job => job.short === short) ?? null
}

/** True once a job has reached a terminal state. */
function isTerminal(job: JobRecord | null): boolean {
  return job != null && TERMINAL_STATES.has(job.state)
}

/**
 * Poll `list` until the job reaches a terminal state or the timeout elapses.
 * On timeout returns the last-seen record (may be non-terminal) so the caller
 * can still report what it observed.
 */
async function pollJob(sockPath: string, short: string, timeoutMs: number): Promise<JobRecord | null> {
  const deadline = Date.now() + timeoutMs
  let lastSeen: JobRecord | null = null
  while (Date.now() < deadline) {
    const job = await findJob(sockPath, short)
    if (job) lastSeen = job
    if (isTerminal(job)) return job
    await sleep(POLL_INTERVAL_MS)
  }
  return lastSeen
}

/** True for objects (non-null) -- a typed `typeof` guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A finite number, or 0 for anything else. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** Parse one JSONL line; null on blank lines or non-JSON. */
function parseJson(line: string): unknown {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** True for a transcript entry that is an assistant message. */
function isAssistantEntry(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && entry.type === 'assistant'
}

/** Pull the `message.usage` object out of an assistant transcript entry. */
function extractUsage(entry: Record<string, unknown>): Record<string, unknown> | null {
  const message = entry.message
  if (!isRecord(message)) return null
  return isRecord(message.usage) ? message.usage : null
}

/** The `usage` object of one transcript line, or null if the line carries none. */
function lineUsage(line: string): Record<string, unknown> | null {
  const entry = parseJson(line)
  if (!isAssistantEntry(entry)) return null
  return extractUsage(entry)
}

/** A zeroed usage accumulator. */
function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, assistantMsgs: 0 }
}

/** Fold one transcript line's usage into the accumulator. */
function addLineUsage(acc: Usage, line: string): void {
  const usage = lineUsage(line)
  if (!usage) return
  acc.input += num(usage.input_tokens)
  acc.output += num(usage.output_tokens)
  acc.cacheCreate += num(usage.cache_creation_input_tokens)
  acc.cacheRead += num(usage.cache_read_input_tokens)
  acc.assistantMsgs += 1
}

/** Sum `usage` token fields across every assistant line of a transcript JSONL. */
function sumUsage(transcriptPath: string): Usage {
  const acc = emptyUsage()
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) addLineUsage(acc, line)
  return acc
}

/** The transcript directory slug for a cwd: real path, `/` and `.` -> `-`. */
function transcriptSlug(cwd: string): string {
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    // cwd already gone (temp dir cleaned) -- slug the path as given.
  }
  // CC's project-dir slug rule: `/`, `.` and `_` all collapse to `-`.
  return real.replace(/[/._]/g, '-')
}

/** Scan every project dir for a transcript named `<sessionId>.jsonl`. */
function scanForTranscript(projectsDir: string, sessionId: string): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Locate a job's transcript JSONL. Tries the computed `<cwd-slug>/<sessionId>`
 * path first, then falls back to a scan keyed on the (unique) session id.
 */
function findTranscript(sessionId: string, cwd: string): string | null {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const direct = join(projectsDir, transcriptSlug(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  return scanForTranscript(projectsDir, sessionId)
}

/** Total tokens across all four usage fields. */
function total(usage: Usage): number {
  return usage.input + usage.output + usage.cacheCreate + usage.cacheRead
}

/** True once a probe produced at least one measured assistant turn. */
function hasTokens(usage: Usage | null): boolean {
  return usage != null && usage.assistantMsgs > 0
}

/** Note explaining a `failed` job -- almost always `--bare` missing an API key. */
function authFailNote(job: JobRecord): string {
  const detail = job.detail ? ` daemon detail: ${job.detail}` : ''
  return `job state=failed -- likely auth (--bare reads ANTHROPIC_API_KEY / apiKeyHelper only).${detail}`
}

/** Build the result for a job that settled to `failed`. */
function failedResult(cfg: ProbeConfig, short: string, job: JobRecord, usage: Usage | null): ProbeResult {
  const measured = hasTokens(usage)
  return {
    config: cfg.config,
    short,
    status: measured ? 'measured' : 'auth-failed',
    finalState: 'failed',
    note: authFailNote(job),
    usage: measured ? (usage as Usage) : undefined,
  }
}

/** Build the result for a non-failed settled job (state `done`/`stopped`/...). */
function settledResult(cfg: ProbeConfig, short: string, job: JobRecord, usage: Usage | null): ProbeResult {
  if (!hasTokens(usage)) {
    return {
      config: cfg.config,
      short,
      status: 'no-transcript',
      finalState: job.state,
      note: 'job settled but its transcript held no measurable assistant turn',
    }
  }
  return { config: cfg.config, short, status: 'measured', finalState: job.state, usage: usage as Usage }
}

/**
 * Classify a TERMINAL job into a ProbeResult, measuring its transcript JSONL.
 * Called only for jobs in a terminal state -- the transcript is read here,
 * before `claude rm`, which wipes it back to metadata-only entries.
 */
function buildResult(cfg: ProbeConfig, short: string, job: JobRecord): ProbeResult {
  const transcript = findTranscript(job.sessionId, job.cwd)
  const usage = transcript ? sumUsage(transcript) : null
  if (job.state === 'failed') return failedResult(cfg, short, job, usage)
  return settledResult(cfg, short, job, usage)
}

/** A `--bare` probe with no API key cannot authenticate -- not measurable here. */
function isBareAuthFailure(cfg: ProbeConfig): boolean {
  return cfg.bare && !process.env.ANTHROPIC_API_KEY
}

/** Note for a `--bare` probe that stalled because it had no credentials. */
function bareAuthNote(lastState: string): string {
  return `--bare probe never completed (last daemon state=${lastState}). ANTHROPIC_API_KEY is unset and --bare ignores keychain/OAuth, so the worker cannot authenticate. This config is not measurable without an API key.`
}

/** Note for a probe that simply ran out of polling time. */
function timeoutNote(lastState: string): string {
  return `no terminal state within ${POLL_TIMEOUT_MS / 1000}s (last daemon state=${lastState})`
}

/**
 * Result for a probe that never reached a terminal state in time. `job` is the
 * last record seen while polling (may be null if it never appeared in `list`).
 */
function timeoutResult(cfg: ProbeConfig, short: string, job: JobRecord | null): ProbeResult {
  const lastState = job ? job.state : 'absent from list'
  const authFail = isBareAuthFailure(cfg)
  return {
    config: cfg.config,
    short,
    status: authFail ? 'auth-failed' : 'timeout',
    finalState: lastState,
    note: authFail ? bareAuthNote(lastState) : timeoutNote(lastState),
  }
}

/** Remove one probe job -- ONLY ever a short id this harness dispatched. */
async function removeJob(short: string): Promise<void> {
  const proc = Bun.spawn(['claude', 'rm', short], { stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  log(`[cleanup] claude rm ${short} -> exit ${proc.exitCode}`)
}

/** Result for a probe whose `claude --bg` printed no job id. */
function dispatchFailedResult(cfg: ProbeConfig, output: string): ProbeResult {
  const shown = truncate(output || '(empty)', 240)
  return { config: cfg.config, status: 'dispatch-failed', note: `claude --bg printed no job id; output: ${shown}` }
}

/** Short human label for a probe config, used in progress logs. */
function cfgLabel(cfg: ProbeConfig): string {
  return cfg.bare ? `${cfg.cwd}, --bare` : cfg.cwd
}

/** Poll one dispatched job to a terminal state and classify the outcome. */
async function measureProbe(sockPath: string, cfg: ProbeConfig, short: string): Promise<ProbeResult> {
  const job = await pollJob(sockPath, short, POLL_TIMEOUT_MS)
  const result = isTerminal(job) ? buildResult(cfg, short, job as JobRecord) : timeoutResult(cfg, short, job)
  log(`[${cfg.config}] short=${short} -> ${result.status} (state=${result.finalState ?? 'n/a'})`)
  return result
}

/** Dispatch, poll, measure and clean up one probe. */
async function runProbe(sockPath: string, cfg: ProbeConfig): Promise<ProbeResult> {
  const name = `cw-cost-${cfg.config}-${Date.now().toString(36)}`
  log(`[${cfg.config}] dispatching (cwd=${cfgLabel(cfg)})`)
  const { short, output } = await dispatchProbe(cfg, name)
  if (!short) return dispatchFailedResult(cfg, output)
  log(`[${cfg.config}] dispatched short=${short}; polling for terminal state...`)
  const result = await measureProbe(sockPath, cfg, short)
  await removeJob(short)
  return result
}

/** A probe is viable only if it completed a real turn that drew tokens. */
function isViable(result: ProbeResult): boolean {
  return result.status === 'measured' && result.usage != null && total(result.usage) > 0
}

/** Cheapest viable config, formatted for the report. */
function recommend(results: ProbeResult[]): string {
  const viable = results.filter(isViable)
  if (viable.length === 0) return 'NONE -- no probe produced a usable measurement'
  const best = viable.reduce((a, b) => (total(a.usage as Usage) <= total(b.usage as Usage) ? a : b))
  return `${best.config} -- ${total(best.usage as Usage).toLocaleString()} tokens`
}

/** A numeric usage cell, or `-` when the probe produced no usage. */
function numCell(usage: Usage | undefined, pick: (u: Usage) => number): string {
  return usage ? String(pick(usage)) : '-'
}

/** One probe rendered as a row of table cells. */
function toRow(result: ProbeResult): string[] {
  const u = result.usage
  return [
    result.config,
    result.status,
    numCell(u, total),
    numCell(u, x => x.input),
    numCell(u, x => x.output),
    numCell(u, x => x.cacheCreate),
    numCell(u, x => x.cacheRead),
    numCell(u, x => x.assistantMsgs),
  ]
}

const HEADERS = ['config', 'status', 'total', 'input', 'output', 'cacheCreate', 'cacheRead', 'msgs']

/** Per-column max width across a grid of rows. */
function columnWidths(grid: string[][]): number[] {
  const widths = new Array<number>(HEADERS.length).fill(0)
  for (const row of grid) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length)
  }
  return widths
}

/** Join one row's cells, each padded to its column width. */
function padRow(cells: string[], widths: number[]): string {
  return cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
}

/** Print the comparison table to stdout. */
function printTable(rows: string[][]): void {
  const widths = columnWidths([HEADERS, ...rows])
  console.log(padRow(HEADERS, widths))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(padRow(row, widths))
}

/** Print the full report -- table, per-probe notes, recommendation. */
function printReport(results: ProbeResult[]): void {
  console.log('\n=== cc-daemon cost-measurement spike ===')
  console.log(`model:  ${HAIKU}`)
  console.log(`prompt: ${JSON.stringify(PROMPT)}\n`)
  printTable(results.map(toRow))
  console.log('')
  for (const r of results) {
    if (r.note) console.log(`note [${r.config}]: ${r.note}`)
  }
  console.log(`\nRecommended cheapest viable config: ${recommend(results)}`)
}

/** One markdown table row. */
function mdRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/** Per-probe note as markdown bullet lines (empty when there is no note). */
function probeNotesMd(result: ProbeResult): string[] {
  return result.note ? [`- \`${result.config}\`: ${result.note}`] : []
}

/** Render the committed results summary as markdown. */
function renderSummaryMd(results: ProbeResult[]): string {
  const lines = [
    '# cc-daemon cost-measurement spike -- results',
    '',
    'Generated by `scripts/cc-daemon-cost-spike.ts`. Re-run to refresh.',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Model: \`${HAIKU}\``,
    `- Prompt: \`${PROMPT}\``,
    '',
    mdRow(HEADERS),
    mdRow(HEADERS.map(() => '---')),
    ...results.map(r => mdRow(toRow(r))),
    '',
    `**Recommended cheapest viable config:** ${recommend(results)}`,
    '',
    ...results.flatMap(probeNotesMd),
    '',
  ]
  return `${lines.join('\n')}\n`
}

/** Write the results summary next to this script. */
function writeSummary(results: ProbeResult[]): void {
  const path = join(import.meta.dir, 'cc-daemon-cost-spike.results.md')
  writeFileSync(path, renderSummaryMd(results))
  log(`[summary] wrote ${path}`)
}

/** Remove a temp dir, swallowing errors (best-effort cleanup). */
function rmSafe(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // already gone -- fine.
  }
}

/** Run all probes sequentially and emit the report. */
async function main(): Promise<void> {
  const sockPath = resolveControlSocket()
  if (!sockPath) {
    log('FATAL: no Claude Code daemon reachable (resolveControlSocket() -> null). Is `claude daemon` running?')
    process.exitCode = 1
    return
  }
  log(`[setup] daemon control socket: ${sockPath}`)
  const bareCwdDir = mkdtempSync(join(tmpdir(), 'cw-cost-bare-'))
  const bareFlagDir = mkdtempSync(join(tmpdir(), 'cw-cost-flag-'))
  const results: ProbeResult[] = []
  for (const cfg of buildConfigs(bareCwdDir, bareFlagDir)) {
    results.push(await runProbe(sockPath, cfg))
  }
  rmSafe(bareCwdDir)
  rmSafe(bareFlagDir)
  printReport(results)
  writeSummary(results)
}

if (import.meta.main) {
  await main()
}

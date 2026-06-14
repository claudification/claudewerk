/**
 * Historical transcript import (`rclaude --rclaude-import-history`).
 *
 * Reads every local Claude Code transcript under
 * `<claudeConfigDir>/projects/<slug>/*.jsonl` and uploads them to the broker
 * over the SAME WebSocket protocol the live agent host uses (`meta` +
 * `transcript_entries` + `end`), so the broker's FTS5 search covers this
 * machine's history. Lives in the agent host (not broker-cli) because the broker
 * isn't installed on every machine but `rclaude` is.
 *
 * Attribution: each conversation's project URI authority is the machine's
 * sentinel alias -> `claude://<alias>/<cwd>`, matching how the broker rewrites
 * live conversations to their hosting sentinel's alias (`resolveProjectUri`).
 * Import connections aren't sentinel-bound, so the alias arrives via
 * `--sentinel` -- and is therefore VALIDATED against the broker's sentinel
 * registry before anything uploads: a typo'd alias would otherwise mint a
 * phantom machine.
 *
 * Skipped by default:
 *  - Sub-agent (Task-tool sidechain) transcripts (`agent-*.jsonl`) -- the
 *    broker's data model nests those under the parent's agent scope; imported
 *    standalone they'd pollute the conversation list. `--include-agents` opts in.
 *  - Sessions already live on the broker (a non-import conversation whose id
 *    equals the local ccSessionId -- the rclaude convention) -- importing those
 *    would index the same content twice.
 *
 * Idempotent: the broker dedupes transcript entries by `(conversationId, uuid)`
 * via INSERT OR IGNORE. Two invariants make re-runs no-ops:
 *   1. A STABLE, machine-namespaced conversationId per local session.
 *   2. A STABLE uuid on every entry. CC control lines (custom-title, agent-name,
 *      permission-mode, file-history-snapshot, last-prompt) carry no uuid, and
 *      the broker would otherwise synthesize a RANDOM one per upload -> duplicates
 *      on every re-run. We synthesize a DETERMINISTIC uuid for those instead.
 *   3. The FIRST transcript_entries batch is `isInitial: true`: the SQLite store
 *      dedupes by uuid, but the broker's in-memory hot cache push-appends
 *      `isInitial: false` batches -- a re-import would double the live cache.
 *      isInitial on the first batch makes the cache REPLACE instead, so re-runs
 *      re-sync both layers to exactly the source set.
 *
 * Memory: sessions are parsed ONE AT A TIME inside the upload loop (not
 * pre-loaded), so a machine with years of history doesn't hold every entry
 * in RAM at once.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { claudeConfigDir } from '../shared/claude-config-dir'
import { createHostTransport } from '../shared/host-transport'
import { cwdToProjectUri } from '../shared/project-uri'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type AgentHostMessage,
  type ConversationEnd,
  type ConversationMeta,
  type TranscriptEntry,
} from '../shared/protocol'
import { ccSessionIdFromJsonl, isAgentTranscriptFile } from '../shared/transcript-path'
import { BUILD_VERSION } from '../shared/version'
import { wsToHttpUrl } from '../shared/ws-url'

export interface ImportOptions {
  brokerUrl: string
  brokerSecret: string | undefined
  /** Sentinel alias -> project URI authority (`claude://<alias>/...`).
   *  Validated against the broker's sentinel registry before upload. */
  sentinel: string
  dryRun: boolean
  /** Only sessions whose newest entry is >= this epoch-ms are imported. */
  since?: number
  /** Import sub-agent (`agent-*.jsonl`) transcripts too. Default: skip. */
  includeAgents?: boolean
  /** Defaults to `<claudeConfigDir>/projects`. */
  projectsDir?: string
  log?: (msg: string) => void
}

export interface ParsedSession {
  sessionUuid: string
  cwd: string
  conversationId: string
  project: string
  startedAt: number
  endedAt: number
  entries: TranscriptEntry[]
  file: string
}

/** Entries are streamed in batches this size. 200 stays well under the transport's
 *  oversize warning and matches the live pull default. */
const CHUNK = 200
/** Per-session upload hard cap so one stuck socket can't wedge the whole run. */
const SESSION_TIMEOUT_MS = 30_000
/** Grace period after the last frame is written before closing the socket.
 *  There is no per-batch ack in the protocol; sends are synchronous while
 *  connected, so this only covers socket-level flush. Scale note: this is a
 *  per-session cost -- 1000 sessions pay ~12 min of pure grace. */
const FLUSH_GRACE_MS = 750

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Stable, machine-namespaced conversation id: re-runs map to the same broker row
 *  and imports never collide with a live session that reuses the CC session id. */
export function deriveConversationId(sentinel: string, cwd: string, sessionUuid: string): string {
  return `import-${sha(`${sentinel}\n${cwd}\n${sessionUuid}`).slice(0, 32)}`
}

/** Recover the real cwd from the first entry that carries one. The on-disk slug
 *  (`/._` -> `-`) is lossy and not invertible, so we never decode it. */
export function recoverCwd(entries: TranscriptEntry[]): string | undefined {
  for (const e of entries) {
    const cwd = (e as { cwd?: unknown }).cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return undefined
}

function entryTimeMs(e: TranscriptEntry): number | undefined {
  const ts = (e as { timestamp?: unknown }).timestamp
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    return Number.isNaN(ms) ? undefined : ms
  }
  if (typeof ts === 'number') return ts
  return undefined
}

/** Guarantee every entry has a STABLE uuid so re-uploads dedupe. Entries that
 *  already carry one are returned untouched; uuid-less ones get a deterministic
 *  `imp-` uuid derived from their content + position. */
export function ensureStableUuids(conversationId: string, entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((e, i) => {
    const uuid = (e as { uuid?: unknown }).uuid
    if (typeof uuid === 'string' && uuid.length > 0) return e
    const synthetic = `imp-${sha(`${conversationId}\n${i}\n${JSON.stringify(e)}`).slice(0, 32)}`
    return { ...(e as Record<string, unknown>), uuid: synthetic } as unknown as TranscriptEntry
  })
}

/** Split entries into wire batches. The FIRST batch is `isInitial: true` --
 *  see the idempotency invariant (3) in the module doc. */
export function planBatches(entries: TranscriptEntry[]): Array<{ entries: TranscriptEntry[]; isInitial: boolean }> {
  const out: Array<{ entries: TranscriptEntry[]; isInitial: boolean }> = []
  for (let i = 0; i < entries.length; i += CHUNK) {
    out.push({ entries: entries.slice(i, i + CHUNK), isInitial: i === 0 })
  }
  return out
}

export function parseJsonlEntries(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as TranscriptEntry)
    } catch {
      // Skip malformed lines -- a partial/truncated tail shouldn't sink the file.
    }
  }
  return out
}

/** Parse one session JSONL into an upload-ready ParsedSession, or null when it
 *  has no recoverable cwd / no entries (can't attribute it to a project). */
export function parseSession(file: string, sentinel: string): ParsedSession | null {
  const sessionUuid = ccSessionIdFromJsonl(basename(file))
  if (!sessionUuid) return null
  const raw = parseJsonlEntries(readFileSync(file, 'utf-8'))
  if (raw.length === 0) return null
  const cwd = recoverCwd(raw)
  if (!cwd) return null
  const conversationId = deriveConversationId(sentinel, cwd, sessionUuid)
  const entries = ensureStableUuids(conversationId, raw)
  const times = raw.map(entryTimeMs).filter((n): n is number => n !== undefined)
  const startedAt = times.length ? Math.min(...times) : Date.now()
  const endedAt = times.length ? Math.max(...times) : startedAt
  return {
    sessionUuid,
    cwd,
    conversationId,
    project: cwdToProjectUri(cwd, 'claude', sentinel),
    startedAt,
    endedAt,
    entries,
    file,
  }
}

interface CandidateFile {
  file: string
  sessionUuid: string
  mtimeMs: number
}

/** Enumerate candidate JSONL files cheaply (no parsing): path + mtime only.
 *  Agent transcripts are filtered here unless includeAgents. */
export async function enumerateCandidates(projectsDir: string, includeAgents: boolean): Promise<CandidateFile[]> {
  const glob = new Bun.Glob('**/*.jsonl')
  const out: CandidateFile[] = []
  for await (const file of glob.scan({ cwd: projectsDir, absolute: true })) {
    const name = basename(file)
    if (!includeAgents && isAgentTranscriptFile(name)) continue
    const sessionUuid = ccSessionIdFromJsonl(name)
    if (!sessionUuid) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      continue // vanished between scan and stat
    }
    out.push({ file, sessionUuid, mtimeMs })
  }
  // Oldest first -- deterministic, and the broker sees history in time order.
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

// ─── broker HTTP preflight ──────────────────────────────────────────────────

async function brokerGet(httpBase: string, path: string, secret: string): Promise<unknown | null> {
  try {
    const resp = await fetch(`${httpBase}${path}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/** Registered sentinel aliases, or null when the registry is unreachable. */
export async function fetchRegistryAliases(httpBase: string, secret: string): Promise<string[] | null> {
  const data = await brokerGet(httpBase, '/api/sentinels', secret)
  if (!data) return null
  const arr = Array.isArray(data) ? data : ((data as { sentinels?: unknown[] }).sentinels ?? [])
  return (arr as Array<{ alias?: unknown }>).map(s => s.alias).filter((a): a is string => typeof a === 'string')
}

/** Ids of NON-import conversations on the broker. For rclaude sessions the
 *  conversation id IS the ccSessionId, so a local session whose uuid appears
 *  here is already on the broker live -- importing it would index the same
 *  content twice. (Sessions promoted under a different conversationId aren't
 *  detectable from the overview -- it doesn't expose ccSessionId -- so this
 *  is best-effort; see PR notes.) Returns null when unreachable. */
export async function fetchLiveConversationIds(httpBase: string, secret: string): Promise<Set<string> | null> {
  const data = await brokerGet(httpBase, '/conversations', secret)
  if (!data || !Array.isArray(data)) return null
  const ids = new Set<string>()
  for (const c of data as Array<{ id?: unknown }>) {
    if (typeof c.id === 'string' && !c.id.startsWith('import-')) ids.add(c.id)
  }
  return ids
}

// ─── upload ─────────────────────────────────────────────────────────────────

/** Upload one session over a dedicated short-lived transport: connect -> `meta`
 *  (sent by buildInitialMessage on open) -> batched `transcript_entries` -> `end`
 *  -> brief flush grace -> close. */
function uploadSession(s: ParsedSession, opts: ImportOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const meta: ConversationMeta = {
      type: 'meta',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      ccSessionId: s.sessionUuid,
      conversationId: s.conversationId,
      project: s.project,
      startedAt: s.startedAt,
      agentHostType: 'claude',
      version: `rclaude-import/${BUILD_VERSION.gitHashShort}`,
      buildTime: BUILD_VERSION.buildTime,
    }

    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const hardTimer = setTimeout(() => done(new Error(`timeout after ${SESSION_TIMEOUT_MS}ms`)), SESSION_TIMEOUT_MS)
    function done(err?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      if (graceTimer) clearTimeout(graceTimer)
      try {
        transport.close()
      } catch {
        /* already closed */
      }
      err ? reject(err) : resolve()
    }

    const transport = createHostTransport({
      brokerUrl: opts.brokerUrl,
      brokerSecret: opts.brokerSecret,
      conversationId: s.conversationId,
      buildInitialMessage: () => meta as AgentHostMessage,
      // A batch tool must never inherit the live host's exit-on-upgrade behaviour.
      onProtocolUpgradeRequired: 'throw',
      onError: e => done(e instanceof Error ? e : new Error(String(e))),
      onConnected: () => {
        for (const batch of planBatches(s.entries)) {
          transport.sendTranscriptEntries(batch.entries, batch.isInitial)
        }
        const end: ConversationEnd = {
          type: 'end',
          conversationId: s.conversationId,
          ccSessionId: s.sessionUuid,
          reason: 'history-import',
          source: 'history-import',
          detail: {
            ccSessionId: s.sessionUuid,
            note: `imported ${s.entries.length} entries from ${s.file}`,
            hostVersion: `rclaude-import/${BUILD_VERSION.gitHashShort}`,
          },
          endedAt: s.endedAt,
        }
        transport.send(end as AgentHostMessage)
        transport.flush()
        graceTimer = setTimeout(() => done(), FLUSH_GRACE_MS)
      },
    })
  })
}

// ─── orchestration ──────────────────────────────────────────────────────────

/** Orchestrate the import. Returns the number of sessions successfully uploaded
 *  (or the count that would upload, for a dry run). Throws on configuration
 *  errors (unknown alias, unreachable broker on a real run, missing secret). */
export async function runImportHistory(opts: ImportOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`))
  const projectsDir = opts.projectsDir ?? `${claudeConfigDir()}/projects`
  const httpBase = wsToHttpUrl(opts.brokerUrl)

  if (!opts.brokerSecret) {
    throw new Error('no broker secret -- set RCLAUDE_SECRET (or pass --rclaude-secret). Refusing to connect.')
  }

  // Preflight 1: the alias must exist in the broker's sentinel registry --
  // a typo'd --sentinel would otherwise mint a phantom machine authority.
  const aliases = await fetchRegistryAliases(httpBase, opts.brokerSecret)
  if (aliases === null) {
    if (opts.dryRun) {
      log(`[import] WARN: sentinel registry unreachable at ${httpBase} -- alias '${opts.sentinel}' NOT validated`)
    } else {
      throw new Error(`sentinel registry unreachable at ${httpBase} -- cannot validate --sentinel. Aborting.`)
    }
  } else if (!aliases.includes(opts.sentinel)) {
    throw new Error(
      `--sentinel '${opts.sentinel}' is not a registered sentinel alias. Registered: ${aliases.join(', ') || '(none)'}`,
    )
  }

  // Preflight 2: ids of conversations already live on the broker (skip those).
  const liveIds = await fetchLiveConversationIds(httpBase, opts.brokerSecret)
  if (liveIds === null && !opts.dryRun) {
    throw new Error(`cannot list broker conversations at ${httpBase} -- live-session dedupe unavailable. Aborting.`)
  }

  log(`[import] scanning ${projectsDir} ...`)
  const candidates = await enumerateCandidates(projectsDir, opts.includeAgents ?? false)
  log(
    `[import] ${candidates.length} candidate session(s)` +
      `${opts.includeAgents ? ' (sub-agent transcripts included)' : ' (sub-agent transcripts skipped; --include-agents to import them)'}` +
      ` -> claude://${opts.sentinel}/...`,
  )

  let ok = 0
  let skippedLive = 0
  let skippedUnparseable = 0
  let skippedSince = 0
  let totalEntries = 0
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]
    const tag = `[${i + 1}/${candidates.length}]`

    if (liveIds?.has(cand.sessionUuid)) {
      skippedLive++
      log(`  ${tag} ${cand.sessionUuid}  SKIP (already live on broker)`)
      continue
    }
    // Cheap mtime prefilter -- a file last written before --since can't have
    // newer entries. The precise endedAt check below still applies.
    if (opts.since !== undefined && cand.mtimeMs < opts.since) {
      skippedSince++
      continue
    }

    // Parse lazily, one session at a time -- `s` goes out of scope each loop.
    const s = parseSession(cand.file, opts.sentinel)
    if (!s) {
      skippedUnparseable++
      log(`  ${tag} ${cand.sessionUuid}  SKIP (no recoverable cwd / empty)`)
      continue
    }
    if (opts.since !== undefined && s.endedAt < opts.since) {
      skippedSince++
      continue
    }

    totalEntries += s.entries.length
    if (opts.dryRun) {
      ok++
      log(`  [dry] ${s.sessionUuid}  ${String(s.entries.length).padStart(5)} entries  ${s.project}`)
      continue
    }
    try {
      await uploadSession(s, opts)
      ok++
      log(`  ${tag} ${s.sessionUuid}  ${s.entries.length} entries  OK`)
    } catch (e) {
      log(`  ${tag} ${s.sessionUuid}  FAILED: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const skips = `skipped: ${skippedLive} live, ${skippedSince} before --since, ${skippedUnparseable} unparseable`
  if (opts.dryRun) {
    log(`[import] dry-run: ${ok} session(s) / ${totalEntries} entries would upload (${skips}). Nothing sent.`)
  } else {
    log(`[import] done: ${ok} session(s) / ${totalEntries} entries uploaded to ${opts.brokerUrl} (${skips})`)
  }
  return ok
}

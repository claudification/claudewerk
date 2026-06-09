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
 * sentinel name (e.g. `ultrathink`) -> `claude://ultrathink/<cwd>`, so
 * cross-machine search distinguishes hosts. The broker takes `meta.project`
 * verbatim, so the authority is the ONLY thing that tags a host; nothing
 * derives it for us.
 *
 * Idempotent: the broker dedupes transcript entries by `(conversationId, uuid)`
 * via INSERT OR IGNORE. Two invariants make re-runs no-ops:
 *   1. A STABLE, machine-namespaced conversationId per local session.
 *   2. A STABLE uuid on every entry. CC control lines (custom-title, agent-name,
 *      permission-mode, file-history-snapshot, last-prompt) carry no uuid, and
 *      the broker would otherwise synthesize a RANDOM one per upload -> duplicates
 *      on every re-run. We synthesize a DETERMINISTIC uuid for those instead.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ccSessionIdFromJsonl } from '../daemon-agent-host/transcript-path'
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
import { BUILD_VERSION } from '../shared/version'

export interface ImportOptions {
  brokerUrl: string
  brokerSecret: string | undefined
  /** Sentinel/machine name -> project URI authority (`claude://<sentinel>/...`). */
  sentinel: string
  dryRun: boolean
  /** Only sessions whose newest entry is >= this epoch-ms are imported. */
  since?: number
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

/** Entries are streamed in chunks this size. 200 stays well under the transport's
 *  oversize warning and matches the live pull default. */
const CHUNK = 200
/** Per-session upload hard cap so one stuck socket can't wedge the whole run. */
const SESSION_TIMEOUT_MS = 30_000
/** Grace period after the last frame is written before closing the socket. */
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

export async function enumerateSessions(
  projectsDir: string,
  sentinel: string,
  since?: number,
): Promise<ParsedSession[]> {
  const glob = new Bun.Glob('**/*.jsonl')
  const sessions: ParsedSession[] = []
  for await (const file of glob.scan({ cwd: projectsDir, absolute: true })) {
    const s = parseSession(file, sentinel)
    if (!s) continue
    if (since !== undefined && s.endedAt < since) continue
    sessions.push(s)
  }
  // Oldest first -- deterministic, and the broker sees history in time order.
  sessions.sort((a, b) => a.startedAt - b.startedAt)
  return sessions
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Upload one session over a dedicated short-lived transport: connect -> `meta`
 *  (sent by buildInitialMessage on open) -> chunked `transcript_entries` -> `end`
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
        // `meta` was already sent by buildInitialMessage on open. Stream entries
        // with the FIRST chunk as isInitial=true. This is the crux of cache
        // idempotency: the broker's SQLite store dedupes by (conversationId,
        // uuid), but its in-memory hot cache does NOT -- an isInitial=false batch
        // is push-appended (add-transcript-entries.ts `appendToCache`), so a
        // re-import would DOUBLE the live cache (store stays correct). isInitial
        // on the first chunk makes the cache REPLACE rather than append, so a
        // re-run re-syncs to exactly the source set on both layers. Matches how
        // the live transcript watcher seeds a full-file read.
        const parts = chunk(s.entries, CHUNK)
        for (let p = 0; p < parts.length; p++) {
          transport.sendTranscriptEntries(parts[p], p === 0)
        }
        const end: ConversationEnd = {
          type: 'end',
          conversationId: s.conversationId,
          ccSessionId: s.sessionUuid,
          reason: 'import-complete',
          endedAt: s.endedAt,
        }
        transport.send(end as AgentHostMessage)
        // No per-batch ack exists in the protocol; sends are synchronous while
        // connected, so a short grace lets the socket drain before we close.
        transport.flush()
        graceTimer = setTimeout(() => done(), FLUSH_GRACE_MS)
      },
    })
  })
}

/** Orchestrate the import. Returns the number of sessions successfully uploaded
 *  (or the count discovered, for a dry run). */
export async function runImportHistory(opts: ImportOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`))
  const projectsDir = opts.projectsDir ?? `${claudeConfigDir()}/projects`

  log(`[import] scanning ${projectsDir} ...`)
  const sessions = await enumerateSessions(projectsDir, opts.sentinel, opts.since)
  const totalEntries = sessions.reduce((n, s) => n + s.entries.length, 0)
  log(`[import] found ${sessions.length} session(s), ${totalEntries} entries -> claude://${opts.sentinel}/...`)

  if (opts.dryRun) {
    for (const s of sessions) {
      log(`  [dry] ${s.sessionUuid}  ${String(s.entries.length).padStart(5)} entries  ${s.project}`)
    }
    log('[import] dry-run: nothing uploaded.')
    return sessions.length
  }

  if (!opts.brokerSecret) {
    throw new Error('no broker secret -- set RCLAUDE_SECRET (or pass --rclaude-secret). Refusing to connect.')
  }

  let ok = 0
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const tag = `[${i + 1}/${sessions.length}]`
    try {
      await uploadSession(s, opts)
      ok++
      log(`  ${tag} ${s.sessionUuid}  ${s.entries.length} entries  OK`)
    } catch (e) {
      log(`  ${tag} ${s.sessionUuid}  FAILED: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  log(`[import] done: ${ok}/${sessions.length} session(s) uploaded to ${opts.brokerUrl}`)
  return ok
}

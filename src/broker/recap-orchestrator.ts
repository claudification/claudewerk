import type {
  PeriodRecapDoc,
  RecapDigest,
  RecapLogEntry,
  RecapMetadata,
  RecapPeriodLabel,
  RecapSearchHit,
  RecapStatus,
  RecapSummary,
} from '../shared/protocol'
import { isRecapTerminal } from '../shared/protocol'
import { createRecapBundleWriter } from './recap/period/bundle'
import { reapCeilingMs } from './recap/period/deadline'
import type { CommitDigest, PeriodScope } from './recap/period/gather/types'
import {
  type RegenerateArgs,
  type RegenerateResult,
  type ResumeResult,
  regenerateRecap,
  resumeRecap,
  type StartArgs,
  type StartResult,
  startRecap,
} from './recap/period/orchestrator'
import type { ProgressBroadcaster } from './recap/period/progress'
import { createPeriodRecapStore, type PeriodRecapStore, type RecapRow, rowToRecapMeta } from './recap/period/store'
import type { StoreDriver } from './store/types'

let singleton: RecapOrchestrator | null = null

/** Keep banked map/merge output ~30 days for a cost-safe resume, then reclaim
 *  disk. Overridable via CLAUDWERK_RECAP_BUNDLE_RETENTION_MS. */
const DEFAULT_BUNDLE_RETENTION_MS = 30 * 24 * 60 * 60_000

export interface RecapOrchestrator {
  start(args: StartArgs): Promise<StartResult>
  /** Pillar C++: re-run a recap from a downstream stage off its on-disk bundle. */
  regenerate(args: RegenerateArgs): RegenerateResult
  /** G3: resume an interrupted/partial/failed chunked recap, reusing persisted
   *  chunks and re-running only the missing ones. */
  resume(recapId: string): ResumeResult
  /** G2: on broker boot, reclaim recaps stuck in-flight (their async died with the
   *  process) -> 'interrupted' (resumable, never auto-resumed). Returns what it swept. */
  sweepInterrupted(): Array<{ id: string; prevStatus: RecapStatus; progress: number }>
  /** Live backstop (runs periodically, NOT just at boot): force-fail any in-flight
   *  recap whose last activity is older than the reap ceiling -- a run wedged while
   *  the broker stayed up (the in-process overall deadline never fired). Marks it
   *  `failed` (reported, resumable off the banked bundle). Returns what it reaped. */
  reapStale(): Array<{ id: string; prevStatus: RecapStatus; ageMs: number }>
  /** Retention: delete terminal on-disk bundles past the retention window (default
   *  ~30 days, env CLAUDWERK_RECAP_BUNDLE_RETENTION_MS). Returns removed recapIds. */
  pruneBundles(): string[]
  cancel(recapId: string): void
  dismiss(recapId: string): void
  list(filter: { projectUri?: string; status?: RecapStatus[]; limit?: number }): RecapSummary[]
  get(recapId: string, includeLogs: boolean): { recap: PeriodRecapDoc; logs?: RecapLogEntry[] } | null
  search(query: string, opts: { projectFilter?: string; limit?: number }): RecapSearchHit[]
  getMarkdown(recapId: string): string | null
  store: PeriodRecapStore
}

export interface InitOptions {
  cacheDir: string
  brokerStore: StoreDriver
  broadcaster: ProgressBroadcaster
  /** Deliver a recap-completed channel message into a conversation
   *  (inform_on_complete). Wired by the broker; no-op if absent. */
  informConversation?: (conversationId: string, msg: { recapId: string; text: string }) => void
  /** Real commit gathering via the sentinel git_log RPC (recap grounding).
   *  Wired by the broker (which owns sentinel connections). */
  gatherCommits?: (scope: PeriodScope) => Promise<CommitDigest>
}

export function initRecapOrchestrator(opts: InitOptions): RecapOrchestrator {
  const store = createPeriodRecapStore(opts.cacheDir)
  // Pillar C+: run-artifact bundles live next to store.db under the same
  // persisted cacheDir volume (<cacheDir>/recaps/<recapId>/).
  const bundle = createRecapBundleWriter(opts.cacheDir)
  singleton = {
    start: args =>
      startRecap(
        {
          store,
          brokerStore: opts.brokerStore,
          broadcaster: opts.broadcaster,
          informConversation: opts.informConversation,
          gatherCommits: opts.gatherCommits,
          bundle,
        },
        args,
      ),
    regenerate: args =>
      regenerateRecap(
        {
          store,
          brokerStore: opts.brokerStore,
          broadcaster: opts.broadcaster,
          informConversation: opts.informConversation,
          gatherCommits: opts.gatherCommits,
          bundle,
        },
        args,
      ),
    resume: recapId =>
      resumeRecap(
        {
          store,
          brokerStore: opts.brokerStore,
          broadcaster: opts.broadcaster,
          informConversation: opts.informConversation,
          gatherCommits: opts.gatherCommits,
          bundle,
        },
        recapId,
      ),
    sweepInterrupted() {
      // No async run can survive a broker restart, so EVERY in-flight row is
      // orphaned. Flip each to 'interrupted' (resumable) + emit a structured
      // message; NEVER auto-resume (interrupted_manual -- no surprise spend).
      const orphaned = store.list({ status: ['queued', 'gathering', 'rendering'] })
      const swept: Array<{ id: string; prevStatus: RecapStatus; progress: number }> = []
      for (const row of orphaned) {
        const note = `interrupted by broker restart (was ${row.status} at ${row.progress}%; resumable)`
        store.update(row.id, { status: 'interrupted', error: note })
        bundle.updateManifest(row.id, { status: 'interrupted', error: note })
        opts.broadcaster.broadcast({
          type: 'recap_progress',
          recapId: row.id,
          status: 'interrupted',
          progress: row.progress,
          phase: 'interrupted',
          log: { level: 'warn', message: note, ts: Date.now() },
        })
        swept.push({ id: row.id, prevStatus: row.status, progress: row.progress })
      }
      return swept
    },
    reapStale() {
      const ceilingMs = reapCeilingMs()
      const now = Date.now()
      const reaped: Array<{ id: string; prevStatus: RecapStatus; ageMs: number }> = []
      for (const row of store.list({ status: ['queued', 'gathering', 'rendering'] })) {
        // Liveness = the most recent of (last log line, run start, row creation).
        // A healthy long run keeps emitting progress logs; a wedged one goes silent.
        const lastActivity = Math.max(store.lastActivityAt(row.id) ?? 0, row.startedAt ?? 0, row.createdAt)
        const ageMs = now - lastActivity
        if (ageMs <= ceilingMs) continue
        const note = `reaped: no activity for ${Math.round(ageMs / 1000)}s (was ${row.status} at ${row.progress}%) -- exceeded the ${Math.round(ceilingMs / 1000)}s reap ceiling; banked output kept for resume`
        console.error(`[recap] ${row.id} ${note}`)
        store.update(row.id, { status: 'failed', error: note, completedAt: now })
        bundle.updateManifest(row.id, { status: 'failed', error: note, completedAt: now })
        opts.broadcaster.broadcast({
          type: 'recap_progress',
          recapId: row.id,
          status: 'failed',
          progress: row.progress,
          phase: 'failed',
          log: { level: 'error', message: note, ts: now },
        })
        if (row.informConversationId && opts.informConversation) {
          opts.informConversation(row.informConversationId, {
            recapId: row.id,
            text: `Recap ${row.id} failed (timed out): ${note}. Retry to resume from banked output.`,
          })
        }
        reaped.push({ id: row.id, prevStatus: row.status, ageMs })
      }
      return reaped
    },
    pruneBundles() {
      const envMs = Number(process.env.CLAUDWERK_RECAP_BUNDLE_RETENTION_MS)
      const retentionMs = Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_BUNDLE_RETENTION_MS
      return bundle.pruneOlderThan(retentionMs)
    },
    cancel(recapId: string) {
      const row = store.get(recapId)
      // Already finished (done/partial/failed/cancelled) -> nothing to cancel.
      // An 'interrupted' recap is NOT terminal: it can still be cancelled
      // (give up on the resume) -- isRecapTerminal lets that through.
      if (!row || isRecapTerminal(row.status)) return
      store.update(recapId, { status: 'cancelled' })
      opts.broadcaster.broadcast({
        type: 'recap_progress',
        recapId,
        status: 'cancelled',
        progress: row.progress,
        phase: 'cancelled',
      })
    },
    dismiss(recapId: string) {
      store.update(recapId, { dismissedAt: Date.now() })
    },
    list(filter) {
      return store.list(filter).map(rowToSummary)
    },
    get(recapId, includeLogs) {
      const row = store.get(recapId)
      if (!row) return null
      const recap = rowToDoc(row)
      // Surface the refinement inputs the write-up was generated with (bundle
      // manifest, not a DB column) so the regenerate modal prefills them.
      const manifest = bundle.readManifest(recapId)
      if (manifest?.instructions) recap.instructions = manifest.instructions
      const variantLabel = manifest?.recipe?.variantLabel
      if (typeof variantLabel === 'string' && variantLabel) recap.variantLabel = variantLabel
      if (!includeLogs) return { recap }
      return { recap, logs: store.getLogs(recapId) as RecapLogEntry[] }
    },
    search(query, opts) {
      return store.searchFts(query, { projectUri: opts.projectFilter, limit: opts.limit }).map(hit => ({
        id: hit.recapId,
        projectUri: hit.projectUri,
        periodLabel: 'custom' as RecapPeriodLabel,
        periodStart: 0,
        periodEnd: 0,
        title: '',
        subtitle: '',
        snippet: hit.snippet,
        score: hit.rank,
        createdAt: 0,
      }))
    },
    getMarkdown(recapId) {
      return store.get(recapId)?.markdown ?? null
    },
    store,
  }
  return singleton
}

export function getRecapOrchestrator(): RecapOrchestrator | null {
  return singleton
}

/** Test-only: clear the module-level orchestrator singleton. The orchestrator is
 *  a process-global, so any test that calls initRecapOrchestrator() leaks it into
 *  later test files in the same `bun test` run. Tests that depend on a KNOWN
 *  orchestrator state (e.g. the recap-roles trust-gate tests, which rely on it
 *  being uninitialised) must reset it to avoid cross-file pollution. */
export function resetRecapOrchestratorForTests(): void {
  singleton = null
}

function rowToSummary(row: RecapRow): RecapSummary {
  const variantLabel = variantLabelOf(row)
  return {
    id: row.id,
    projectUri: row.projectUri,
    periodLabel: row.periodLabel as RecapPeriodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    audience: row.audience,
    status: row.status,
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
    llmCostUsd: row.llmCostUsd,
    model: row.model ?? undefined,
    progress: row.progress,
    phase: row.phase ?? undefined,
    error: row.error ?? undefined,
    ...(variantLabel ? { variantLabel } : {}),
  }
}

/** Pull the variant label out of the persisted recipe (args_json) -- a cheap
 *  row-level read (no bundle manifest) so the fork switcher can name variants. */
function variantLabelOf(row: RecapRow): string | undefined {
  const recipe = parseJsonOr<Record<string, unknown>>(row.argsJson)
  const label = recipe?.variantLabel
  return typeof label === 'string' && label ? label : undefined
}

function rowToDoc(row: RecapRow): PeriodRecapDoc {
  return {
    ...rowToRecapMeta(row),
    markdown: row.markdown ?? undefined,
    metadata: parseJsonOr<RecapMetadata>(row.metadataJson),
    digest: parseJsonOr<RecapDigest>(row.digestJson),
  }
}

/** Parse a persisted JSON blob, tolerating null/garbage (pre-2.0 rows have
 *  no digest_json and may predate a metadata field; degrade to undefined). */
function parseJsonOr<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Pillar C+ -- the on-disk RUN-ARTIFACT BUNDLE.
 *
 * Principle (Jonas): "we don't throw away information we paid for." Every recap
 * run writes a self-contained, incrementally-flushed bundle so we can re-evaluate
 * where a run went wrong, see exactly what a $X recap bought, and re-run it
 * (Pillar C++ resume rides this). Motivating case: recap_qs5pmdtjz4wh -- its
 * truncated output survived only by luck in error.raw; a bundle preserves it by
 * construction.
 *
 * Layout (dir per recapId, mirrors the broker's blobs/ + terminations/ patterns
 * under the persisted cacheDir volume):
 *
 *   <cacheDir>/recaps/<recapId>/
 *     manifest.json                       resolved config + timing + status +
 *                                         ledger summary + pipelineVersion + batchId
 *     progress.ndjson                     full RecapLogEntry-shaped progress trail
 *     calls/NNN-<stage>[-cK].prompt.json  assembled prompt actually sent (model +
 *                                         params + system/user/messages -- NO secret)
 *     calls/NNN-<stage>[-cK].response.txt raw response content (incl. truncations)
 *     calls/NNN-<stage>[-cK].response.raw.json  full OpenRouter envelope
 *     calls/NNN-<stage>[-cK].error.json   recorded when the call THREW
 *     chunks/map-K.parsed.json            per-chunk CHUNKED:Intermediary parsed JSON
 *     merged.json                         deterministic <merge> output
 *     final.md                            final rendered markdown
 *
 * CONSTRAINTS (Pillar C+):
 *   - Reference transcripts by conversation id; never duplicate raw transcript
 *     bulk. We save the ASSEMBLED PROMPT (what we paid to send), which already
 *     contains the curated digest -- not the source store.db transcripts.
 *   - SCRUB SECRETS. The only place the OpenRouter key lands is the
 *     `Authorization: Bearer` HTTP header (openrouter-client buildBody never puts
 *     it in the body). This writer only ever serializes model/params/messages, so
 *     a key cannot reach disk -- but recordCallPrompt is the chokepoint, so we
 *     keep it dumb-by-construction (it has no apiKey field to write).
 *   - Write INCREMENTALLY (flush per step); a crash mid-run must leave the partial
 *     trail showing where it died.
 *   - BEST-EFFORT: a disk-full / perms error must NEVER fail a recap. Every method
 *     swallows its error to console.error, exactly like termination-log.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecapAudience, RecapLedgerSummary, RecapPeriodLabel, RecapStatus } from '../../../shared/protocol'

/**
 * Pipeline/schema version. BUMP THIS when the chunk extraction schema, the
 * <merge> output shape, or the CHUNKED:Final / ONESHOT prompt contract changes
 * INCOMPATIBLY -- recap_regenerate (Pillar C++) refuses/warns when a bundle's
 * recorded version no longer matches, rather than silently stitching mismatched
 * stage artifacts into garbage.
 */
export const RECAP_PIPELINE_VERSION = 1

/** Resolved mode chosen by the orchestrator for this run. */
export type RecapBundleMode = 'oneshot' | 'chunked'

export interface RecapBundleInit {
  projectUri: string
  period: { label: RecapPeriodLabel; start: number; end: number; human?: string; isoRange?: string }
  audience: RecapAudience
  /** Retrospect mode flag (Pillar F); recorded for the version-gated resume. */
  retrospect?: boolean
  /** Customer-friendly tone flag; recorded so resume/regenerate re-apply it. */
  customerFriendly?: boolean
  /** Free-text user directives for the final refinement stage; recorded so
   *  resume/regenerate re-apply the same shaping. Trimmed, non-empty when present. */
  instructions?: string
  /** Batch correlation id (eval-harness fan-out). Lives in the manifest, not the
   *  folder name -- the folder key is always the unique recapId. */
  batchId?: string
  createdAt: number
  createdBy?: string
}

/** An assembled prompt for one LLM call. Deliberately has NO apiKey field --
 *  there is no path for a secret to reach disk through this writer. */
export interface RecapBundleCallPrompt {
  stage: string
  chunkIndex?: number
  model: string
  params?: { temperature?: number; maxTokens?: number; responseFormat?: unknown; retries?: number }
  system?: string
  user?: string
  messages?: Array<{ role: string; content: string }>
}

export interface RecapBundleCallResponse {
  ok: boolean
  ms: number
  /** Raw response text (incl. truncations) on success. */
  content?: string
  /** Full OpenRouter envelope on success (token/cost accounting). */
  raw?: unknown
  /** Error message when the call threw. */
  error?: string
}

/** Persisted resolved config + run state. Read by Pillar C++ to decide resume. */
export interface RecapBundleManifest {
  pipelineVersion: number
  recapId: string
  batchId?: string
  projectUri: string
  period: RecapBundleInit['period']
  audience: RecapAudience
  retrospect?: boolean
  customerFriendly?: boolean
  instructions?: string
  /** Resolved render mode (set once produce decides oneshot vs chunked). */
  mode?: RecapBundleMode
  /** Resolved per-stage models actually used. */
  models?: { map?: string; reduce?: string; oneshot?: string }
  chunkCount?: number
  /** The full resolved tuning recipe (Pillar D args_json), mirrored here. */
  recipe?: Record<string, unknown>
  status: RecapStatus
  error?: string
  /** Which downstream-resumable artifacts exist on disk (Pillar C++ validation). */
  artifacts: { merged: boolean; finalMarkdown: boolean; mapChunks: number }
  cost?: RecapLedgerSummary
  timing: { createdAt: number; startedAt?: number; completedAt?: number; updatedAt: number }
  createdBy?: string
  /** Pillar C++ provenance: set when this bundle was produced by recap_regenerate. */
  regenerate?: { from: string; mode: 'fork' | 'in-place'; sourceRecapId: string; at: number }
  /** How many times this recap has been resumed (resume-from-map). Capped so a
   *  permanently-broken recap can't be retried forever. Lives on the manifest
   *  (a bundle concern) -- no DB column needed. */
  resumeCount?: number
}

export type RecapBundleManifestPatch = Partial<
  Pick<
    RecapBundleManifest,
    'mode' | 'models' | 'chunkCount' | 'recipe' | 'status' | 'error' | 'cost' | 'timing' | 'regenerate' | 'resumeCount'
  >
> & { startedAt?: number; completedAt?: number }

export interface RecapBundleWriter {
  /** Bundle dir for a recap (also used by Pillar C++ to read it). */
  dir(recapId: string): string
  /** Create the dir + write the initial manifest. Resets the call counter. */
  begin(recapId: string, init: RecapBundleInit): void
  /** Append one progress/log line to the NDJSON trail. */
  appendProgress(recapId: string, entry: unknown): void
  /** Record an assembled prompt; returns the call seq used to pair the response. */
  recordCallPrompt(recapId: string, prompt: RecapBundleCallPrompt): number
  /** Record the raw response / failure for a prior recordCallPrompt seq. */
  recordCallResponse(recapId: string, seq: number, prompt: RecapBundleCallPrompt, res: RecapBundleCallResponse): void
  /** Per-chunk parsed CHUNKED:Intermediary metadata. */
  recordMapParsed(recapId: string, chunkIndex: number, parsed: unknown): void
  /** Deterministic <merge> output. */
  recordMerged(recapId: string, merged: unknown): void
  /** Raw final-stage response text (CHUNKED:Final / ONESHOT) that parsed. Stored
   *  under a stable name so Pillar C++ `from:'render'` can re-parse it cheaply. */
  recordFinalResponse(recapId: string, content: string): void
  /** Final rendered markdown. */
  recordFinalMarkdown(recapId: string, markdown: string): void
  /** Patch + rewrite the manifest (timing, status, models, ledger summary). */
  updateManifest(recapId: string, patch: RecapBundleManifestPatch): void

  // --- Pillar C++ reads (resumable stage replay) ---
  /** Read the manifest (null if no bundle exists). */
  readManifest(recapId: string): RecapBundleManifest | null
  /** Read the merged JSON (<merge> output) -- the synthesize-stage input. */
  readMerged<T = unknown>(recapId: string): T | null
  /** Read one chunk's persisted parsed extraction (resume-from-map reuses these
   *  instead of re-paying the map call). null if that chunk was never persisted. */
  readMapParsed<T = unknown>(recapId: string, chunkIndex: number): T | null
  /** Read the saved final-stage raw response (render-stage input). */
  readFinalResponse(recapId: string): string | null
  /** Read the first assembled prompt recorded for a stage (e.g. 'oneshot'). */
  readStagePrompt(recapId: string, stage: string): { system?: string; user?: string } | null
  /** Copy a source bundle's UPSTREAM artifacts (manifest/merged/chunks/prompts/
   *  final-response) into a fresh recapId dir for fork-mode regenerate. */
  forkUpstream(srcRecapId: string, dstRecapId: string): void
}

/** Create the bundle writer rooted at `<cacheDir>/recaps`. Mirrors
 *  createTerminationLog(cacheDir): one mkdir at init, best-effort writes after. */
export function createRecapBundleWriter(cacheDir: string): RecapBundleWriter {
  const root = join(cacheDir, 'recaps')
  try {
    mkdirSync(root, { recursive: true })
  } catch (err) {
    console.error('[recap-bundle] init failed:', describe(err))
  }
  // Per-recap call counter (monotonic). Map entries are tiny; evicted on the
  // terminal updateManifest. The map-stage runs calls in parallel, but seq++ is
  // synchronous between awaits (single-threaded) so no two calls share a seq.
  const seqByRecap = new Map<string, number>()

  function bundleDir(recapId: string): string {
    return join(root, recapId)
  }

  function callBase(recapId: string, prompt: RecapBundleCallPrompt, seq: number): string {
    const n = String(seq).padStart(3, '0')
    const suffix = prompt.chunkIndex !== undefined ? `-c${prompt.chunkIndex}` : ''
    return join(bundleDir(recapId), 'calls', `${n}-${prompt.stage}${suffix}`)
  }

  function readJsonFile<T>(path: string): T | null {
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch {
      return null
    }
  }

  function readManifest(recapId: string): RecapBundleManifest | null {
    return readJsonFile<RecapBundleManifest>(join(bundleDir(recapId), 'manifest.json'))
  }

  function writeManifest(recapId: string, manifest: RecapBundleManifest): void {
    try {
      writeFileSync(join(bundleDir(recapId), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    } catch (err) {
      console.error(`[recap-bundle] manifest write failed for ${recapId}:`, describe(err))
    }
  }

  return {
    dir: bundleDir,

    begin(recapId, init) {
      seqByRecap.set(recapId, 0)
      try {
        mkdirSync(join(bundleDir(recapId), 'calls'), { recursive: true })
        mkdirSync(join(bundleDir(recapId), 'chunks'), { recursive: true })
      } catch (err) {
        console.error(`[recap-bundle] mkdir failed for ${recapId}:`, describe(err))
        return
      }
      // A resume re-enters begin() on the SAME bundle. The chunks/*.parsed.json
      // files survive (mkdir is a no-op when they exist), but the manifest is
      // rewritten -- carry forward resumeCount so the max-attempts cap holds.
      const prior = readManifest(recapId)
      const manifest: RecapBundleManifest = {
        pipelineVersion: RECAP_PIPELINE_VERSION,
        recapId,
        ...(init.batchId ? { batchId: init.batchId } : {}),
        projectUri: init.projectUri,
        period: init.period,
        audience: init.audience,
        ...(init.retrospect ? { retrospect: true } : {}),
        ...(init.customerFriendly ? { customerFriendly: true } : {}),
        ...(init.instructions ? { instructions: init.instructions } : {}),
        status: 'gathering',
        artifacts: { merged: false, finalMarkdown: false, mapChunks: 0 },
        timing: { createdAt: init.createdAt, updatedAt: Date.now() },
        ...(init.createdBy ? { createdBy: init.createdBy } : {}),
        ...(prior?.resumeCount ? { resumeCount: prior.resumeCount } : {}),
      }
      writeManifest(recapId, manifest)
    },

    appendProgress(recapId, entry) {
      try {
        appendFileSync(join(bundleDir(recapId), 'progress.ndjson'), `${JSON.stringify(entry)}\n`)
      } catch (err) {
        console.error(`[recap-bundle] progress append failed for ${recapId}:`, describe(err))
      }
    },

    recordCallPrompt(recapId, prompt) {
      const seq = (seqByRecap.get(recapId) ?? 0) + 1
      seqByRecap.set(recapId, seq)
      try {
        // No apiKey field exists on the persisted object -> a secret cannot reach
        // disk here by construction (the bearer key lives only in the HTTP header).
        writeFileSync(`${callBase(recapId, prompt, seq)}.prompt.json`, `${JSON.stringify(prompt, null, 2)}\n`)
      } catch (err) {
        console.error(`[recap-bundle] prompt write failed for ${recapId} seq=${seq}:`, describe(err))
      }
      return seq
    },

    recordCallResponse(recapId, seq, prompt, res) {
      const base = callBase(recapId, prompt, seq)
      try {
        if (res.ok) {
          if (res.content !== undefined) writeFileSync(`${base}.response.txt`, res.content)
          if (res.raw !== undefined) {
            writeFileSync(`${base}.response.raw.json`, `${JSON.stringify(res.raw, null, 2)}\n`)
          }
        } else {
          writeFileSync(
            `${base}.error.json`,
            `${JSON.stringify({ ok: false, error: res.error, ms: res.ms }, null, 2)}\n`,
          )
        }
      } catch (err) {
        console.error(`[recap-bundle] response write failed for ${recapId} seq=${seq}:`, describe(err))
      }
    },

    recordMapParsed(recapId, chunkIndex, parsed) {
      try {
        writeFileSync(
          join(bundleDir(recapId), 'chunks', `map-${chunkIndex}.parsed.json`),
          `${JSON.stringify(parsed, null, 2)}\n`,
        )
        const manifest = readManifest(recapId)
        if (manifest) {
          manifest.artifacts.mapChunks = Math.max(manifest.artifacts.mapChunks, chunkIndex + 1)
          manifest.timing.updatedAt = Date.now()
          writeManifest(recapId, manifest)
        }
      } catch (err) {
        console.error(`[recap-bundle] map-parsed write failed for ${recapId} chunk=${chunkIndex}:`, describe(err))
      }
    },

    recordMerged(recapId, merged) {
      try {
        writeFileSync(join(bundleDir(recapId), 'merged.json'), `${JSON.stringify(merged, null, 2)}\n`)
        const manifest = readManifest(recapId)
        if (manifest) {
          manifest.artifacts.merged = true
          manifest.timing.updatedAt = Date.now()
          writeManifest(recapId, manifest)
        }
      } catch (err) {
        console.error(`[recap-bundle] merged write failed for ${recapId}:`, describe(err))
      }
    },

    recordFinalResponse(recapId, content) {
      try {
        writeFileSync(join(bundleDir(recapId), 'final-response.txt'), content)
      } catch (err) {
        console.error(`[recap-bundle] final-response write failed for ${recapId}:`, describe(err))
      }
    },

    recordFinalMarkdown(recapId, markdown) {
      try {
        writeFileSync(join(bundleDir(recapId), 'final.md'), markdown)
        const manifest = readManifest(recapId)
        if (manifest) {
          manifest.artifacts.finalMarkdown = true
          manifest.timing.updatedAt = Date.now()
          writeManifest(recapId, manifest)
        }
      } catch (err) {
        console.error(`[recap-bundle] final markdown write failed for ${recapId}:`, describe(err))
      }
    },

    readManifest,

    readMerged<T = unknown>(recapId: string): T | null {
      return readJsonFile<T>(join(bundleDir(recapId), 'merged.json'))
    },

    readMapParsed<T = unknown>(recapId: string, chunkIndex: number): T | null {
      return readJsonFile<T>(join(bundleDir(recapId), 'chunks', `map-${chunkIndex}.parsed.json`))
    },

    readFinalResponse(recapId) {
      const path = join(bundleDir(recapId), 'final-response.txt')
      if (!existsSync(path)) return null
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },

    readStagePrompt(recapId, stage) {
      const callsDir = join(bundleDir(recapId), 'calls')
      if (!existsSync(callsDir)) return null
      try {
        // First prompt file for this stage, by seq order (e.g. 001-oneshot.prompt.json).
        const match = readdirSync(callsDir)
          .filter(f => f.endsWith('.prompt.json') && f.includes(`-${stage}`))
          .sort()[0]
        if (!match) return null
        const obj = readJsonFile<{ system?: string; user?: string }>(join(callsDir, match))
        if (!obj) return null
        return { ...(obj.system ? { system: obj.system } : {}), ...(obj.user ? { user: obj.user } : {}) }
      } catch {
        return null
      }
    },

    forkUpstream(srcRecapId, dstRecapId) {
      // Copy the WHOLE source bundle (manifest, merged.json, chunks/, calls/
      // prompts+responses, final-response). The regenerate then overwrites the
      // downstream artifacts (manifest, final.md) on the fork -- upstream is
      // preserved so the eval-harness fork carries the full paid trail.
      try {
        cpSync(bundleDir(srcRecapId), bundleDir(dstRecapId), { recursive: true })
        seqByRecap.set(dstRecapId, 0)
      } catch (err) {
        console.error(`[recap-bundle] fork copy ${srcRecapId} -> ${dstRecapId} failed:`, describe(err))
      }
    },

    updateManifest(recapId, patch) {
      const manifest = readManifest(recapId)
      if (!manifest) return
      if (patch.mode !== undefined) manifest.mode = patch.mode
      if (patch.models !== undefined) manifest.models = patch.models
      if (patch.chunkCount !== undefined) manifest.chunkCount = patch.chunkCount
      if (patch.recipe !== undefined) manifest.recipe = patch.recipe
      if (patch.status !== undefined) manifest.status = patch.status
      if (patch.error !== undefined) manifest.error = patch.error
      if (patch.cost !== undefined) manifest.cost = patch.cost
      if (patch.regenerate !== undefined) manifest.regenerate = patch.regenerate
      if (patch.resumeCount !== undefined) manifest.resumeCount = patch.resumeCount
      if (patch.startedAt !== undefined) manifest.timing.startedAt = patch.startedAt
      if (patch.completedAt !== undefined) manifest.timing.completedAt = patch.completedAt
      manifest.timing.updatedAt = Date.now()
      writeManifest(recapId, manifest)
      // Evict the per-recap counter once the run reaches a terminal state -- the
      // on-disk bundle stands alone; only the in-memory seq needs cleanup.
      // 'interrupted' is NOT terminal (resumable), so it keeps its counter.
      if (
        patch.status === 'done' ||
        patch.status === 'partial' ||
        patch.status === 'failed' ||
        patch.status === 'cancelled'
      ) {
        seqByRecap.delete(recapId)
      }
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

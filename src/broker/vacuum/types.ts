/**
 * VACUUM -- measured reclaim estimates and the plan that acts on them.
 *
 * Every number that reaches the dialog originates here, from a live query. A
 * wrong estimate on a destructive dialog is worse than no estimate, so nothing
 * in this module guesses: where a value is derived rather than counted it is
 * named `projected*` and its derivation is documented at the call site.
 *
 * MEASUREMENT IS TWO-TIERED, and the split is forced by measurement rather than
 * chosen. Timed against the real 10.07 GB store.db:
 *
 *   footprint pragmas                       0.5 s
 *   rows per month                          0.6 s
 *   rows per month + ended attribution      2.6 s
 *   orphan row counts                       2.9 s
 *   SUM(length(block)) over transcript_fts  22.9 s
 *   SUM(octet_length(content)) per month    96.0 s
 *
 * The two byte sums have to read all 6.27 GB of content and 2.25 GB of index,
 * so a dialog that measured everything on open would spin for two minutes. The
 * FAST tier (counts, indexes, gate, files) therefore runs on every open, and
 * the SLOW tier (bytes) is cached to a JSON sidecar and re-run on demand.
 *
 * Row counts are always exact and always fresh. Byte figures carry a
 * `BytesProvenance` saying precisely how old they are and whether they were
 * measured at all -- the dialog renders that, so a stale number can never
 * masquerade as a live one.
 */

/** Where a byte figure came from. Rendered in the dialog, never hidden:
 *  'measured' = read from the database during this request;
 *  'cached'   = from the sidecar written by an earlier byte pass, with its age;
 *  'unmeasured' = no byte pass has ever run, so every byte figure is 0 and the
 *                 dialog must say so rather than imply "nothing to reclaim". */
export type BytesProvenance = 'measured' | 'cached' | 'unmeasured'

export interface BytesMeasurement {
  provenance: BytesProvenance
  /** ISO instant of the byte pass, empty when unmeasured. */
  measuredAt: string
  ageSeconds: number
  durationMs: number
}

/** A UTC month of transcript history and what deleting it would return. */
export interface MonthEstimate {
  month: string
  rows: number
  /** 0 when no byte pass has run -- read `bytes.provenance` before trusting it. */
  contentBytes: number
  /** Rows belonging to conversations whose status is 'ended'. Informational --
   *  the delete is month-granular, not conversation-granular. */
  endedRows: number
  /** True when the month is fully older than the hot window AND not the current
   *  month, i.e. `monthsToArchive` would pick it up. */
  eligible: boolean
  /** True when a verified cold archive already exists for this month. */
  archived: boolean
}

/** Transcript rows whose conversation_id has no row in `conversations`.
 *  Unreachable by every read path -- nothing can ever render them. */
export interface OrphanEstimate {
  rows: number
  contentBytes: number
  conversations: number
  /** Months these rows fall in. The sweep must not touch a month that is still
   *  an archive candidate, or the month's later prune rolls back on the
   *  count mismatch. */
  months: string[]
  /** The subset of `months` the sweep may actually touch. Carried explicitly so
   *  the byte fold reuses this decision instead of re-deriving it -- two copies
   *  of that rule could disagree, and the disagreement would be a wrong number
   *  on a destructive dialog. */
  sweepableMonths: string[]
  /** The subset that is safe to sweep right now, i.e. excluding rows in months
   *  that are pending archive. */
  sweepableRows: number
  sweepableBytes: number
}

/** An index whose column list exactly duplicates another index on the same
 *  table. Dropping one cannot lose data and is reversible with CREATE INDEX. */
export interface RedundantIndex {
  name: string
  /** The index it duplicates and which will be kept. */
  duplicateOf: string
  table: string
  columns: string[]
  /** Rows in the indexed table -- the size driver. */
  tableRows: number
  projectedBytes: number
}

/** A directory swept by file mtime rather than by database row. */
export interface FileSweepEstimate {
  key: string
  label: string
  path: string
  configured: boolean
  files: number
  bytes: number
  /** Files older than the row's age threshold, and their bytes. */
  matchedFiles: number
  matchedBytes: number
}

export interface GateVerdict {
  ok: boolean
  /** The literal reason, shown next to a disabled APPLY. The cron silently
   *  skips; this dialog must not. */
  reason: string
  backupArchive: string
  backupAgeMinutes: number
}

export interface DbFootprint {
  fileBytes: number
  walBytes: number
  totalRows: number
  contentBytes: number
  ftsIndexBytes: number
  /** fileBytes minus content minus FTS: per-row overhead, the nine indexes on
   *  transcript_entries, and every other table. */
  otherBytes: number
  freelistBytes: number
  pageSize: number
  autoVacuum: number
}

export interface VacuumEstimate {
  /** ISO instant the FAST tier ran -- always this request. Row counts, the
   *  gate and the file sweeps are as of this moment. */
  measuredAt: string
  measureDurationMs: number
  /** How old every *byte* figure below is. Always render this next to them. */
  bytes: BytesMeasurement
  hotDays: number
  gate: GateVerdict
  footprint: DbFootprint
  months: MonthEstimate[]
  orphans: OrphanEstimate
  redundantIndexes: RedundantIndex[]
  fileSweeps: FileSweepEstimate[]
  /** What the eligible months alone would return, once VACUUM runs. */
  projectedTranscriptBytes: number
  /** Every selected category summed. */
  projectedTotalBytes: number
  projectedDbBytesAfter: number
  vacuum: VacuumPlan
}

export interface VacuumPlan {
  /** VACUUM rewrites the whole database, so it needs free space roughly equal
   *  to it. Measured, not assumed. */
  freeBytes: number
  neededBytes: number
  hasHeadroom: boolean
  /** Estimated exclusive-lock window, derived from the measured throughput of
   *  the backup pipeline's VACUUM INTO on this same database. */
  estimatedLockSeconds: number
  /** True when the database is still auto_vacuum=NONE, so this run also flips
   *  it to INCREMENTAL and pays the full rewrite exactly once. */
  willEnableIncremental: boolean
}

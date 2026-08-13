/**
 * The shapes `/api/vacuum/*` returns, mirrored for the panel.
 *
 * Declared here rather than imported from `src/broker/vacuum/types` because the
 * panel must not reach into broker internals; this is the wire contract, and it
 * is small enough that a drift would surface immediately in the estimate call.
 */

export type BytesProvenance = 'measured' | 'cached' | 'unmeasured'

export interface BytesMeasurement {
  provenance: BytesProvenance
  measuredAt: string
  ageSeconds: number
  durationMs: number
}

export interface MonthEstimate {
  month: string
  rows: number
  contentBytes: number
  endedRows: number
  eligible: boolean
  archived: boolean
}

export interface OrphanEstimate {
  rows: number
  contentBytes: number
  conversations: number
  months: string[]
  sweepableMonths: string[]
  sweepableRows: number
  sweepableBytes: number
}

export interface RedundantIndex {
  name: string
  duplicateOf: string
  table: string
  columns: string[]
  tableRows: number
  projectedBytes: number
}

export interface FileSweepEstimate {
  key: string
  label: string
  path: string
  configured: boolean
  files: number
  bytes: number
  matchedFiles: number
  matchedBytes: number
}

export interface GateVerdict {
  ok: boolean
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
  otherBytes: number
  freelistBytes: number
  pageSize: number
  autoVacuum: number
}

export interface VacuumPlan {
  freeBytes: number
  neededBytes: number
  hasHeadroom: boolean
  estimatedLockSeconds: number
  willEnableIncremental: boolean
}

export interface VacuumEstimate {
  configured: boolean
  measuredAt: string
  measureDurationMs: number
  bytes: BytesMeasurement
  hotDays: number
  gate: GateVerdict
  footprint: DbFootprint
  months: MonthEstimate[]
  orphans: OrphanEstimate
  redundantIndexes: RedundantIndex[]
  fileSweeps: FileSweepEstimate[]
  projectedTranscriptBytes: number
  projectedTotalBytes: number
  projectedDbBytesAfter: number
  vacuum: VacuumPlan
}

/** What the user has ticked. Transcripts default ON because they are the whole
 *  point; everything else defaults OFF so nothing is deleted by inattention. */
export interface VacuumSelection {
  hotDays: number
  transcripts: boolean
  indexes: boolean
  files: Record<string, number | undefined>
}

export const DEFAULT_SELECTION: VacuumSelection = {
  hotDays: 30,
  transcripts: true,
  indexes: false,
  files: {},
}

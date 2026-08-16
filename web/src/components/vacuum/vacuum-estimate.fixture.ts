/**
 * A complete, plausible `/api/vacuum/estimate` payload for tests.
 *
 * Kept whole rather than partial-with-`as`: the panel reads deep into it
 * (footprint, gate, vacuum plan, month eligibility), and a hollow fixture would
 * only prove the renderer tolerates undefined.
 */

import type { VacuumEstimate } from './vacuum-types'

export function vacuumEstimate(overrides: Partial<VacuumEstimate> = {}): VacuumEstimate {
  return {
    configured: true,
    measuredAt: '2026-08-16T10:00:00.000Z',
    measureDurationMs: 812,
    bytes: { provenance: 'cached', measuredAt: '2026-08-16T08:00:00.000Z', ageSeconds: 7200, durationMs: 118_000 },
    hotDays: 30,
    gate: {
      ok: true,
      reason: 'verified backup-2026-08-16.tar.zst, 40m old',
      backupArchive: 'backup.tar.zst',
      backupAgeMinutes: 40,
    },
    footprint: {
      fileBytes: 10_100_000_000,
      walBytes: 10_000_000,
      totalRows: 1_256_089,
      contentBytes: 8_000_000_000,
      ftsIndexBytes: 1_000_000_000,
      otherBytes: 100_000_000,
      freelistBytes: 0,
      pageSize: 4096,
      autoVacuum: 0,
    },
    months: [
      {
        month: '2026-05',
        rows: 431_701,
        contentBytes: 3_000_000_000,
        endedRows: 400_000,
        eligible: true,
        archived: false,
      },
      { month: '2026-08', rows: 120_000, contentBytes: 900_000_000, endedRows: 10, eligible: false, archived: false },
    ],
    orphans: {
      rows: 0,
      contentBytes: 0,
      conversations: 0,
      months: [],
      sweepableMonths: [],
      sweepableRows: 0,
      sweepableBytes: 0,
    },
    redundantIndexes: [],
    fileSweeps: [],
    projectedTranscriptBytes: 3_000_000_000,
    projectedTotalBytes: 3_000_000_000,
    projectedDbBytesAfter: 7_100_000_000,
    vacuum: {
      freeBytes: 40_000_000_000,
      neededBytes: 11_000_000_000,
      hasHeadroom: true,
      estimatedLockSeconds: 45,
      willEnableIncremental: true,
    },
    ...overrides,
  }
}

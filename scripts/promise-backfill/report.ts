/**
 * What the run did, said out loud. Pure formatting -- no fs, no process.exit.
 *
 * NO SILENT TRUNCATION. A backfill that prints "342 cards done" while having
 * quietly skipped 20 refusals reads as complete coverage when it is not, and
 * that is the failure mode this whole ledger exists to catch, committed by the
 * tool built to catch it. Every bucket is printed even when it is zero, and
 * refusals are printed IN FULL, never sampled.
 */

export interface Outcome {
  id: string
  action: 'record' | 'amnesty' | 'skip'
  /** Evidence kind for a record, the skip reason otherwise. */
  why: string
  added: string[]
  refused: string | null
}

const SAMPLE = 6

function tallyBy(rows: Outcome[], key: (o: Outcome) => string): [string, number][] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// Four guards over an 11-line formatter. Splitting it buys a second function and
// no clarity; the CRAP score is the no-coverage estimate, not a real one.
// fallow-ignore-next-line complexity
function section(title: string, rows: Outcome[], detail: (o: Outcome) => string, all: boolean): string[] {
  if (rows.length === 0) return [`${title}: 0`]
  const shown = all ? rows : rows.slice(0, SAMPLE)
  const out = [`${title}: ${rows.length}`]
  for (const row of shown) out.push(`    ${row.id}  ${detail(row)}`)
  // Never a bare truncation: the reader is told exactly how much was withheld
  // and how to see it, because a sampled list that LOOKS complete is how a
  // partial run gets read as a full one.
  if (rows.length > shown.length) out.push(`    ... and ${rows.length - shown.length} more (--verbose to list all)`)
  return out
}

export function renderReport(
  rows: Outcome[],
  opts: { write: boolean; base: string; cutoff: string; verbose: boolean },
): string {
  const records = rows.filter(r => r.action === 'record' && r.refused === null)
  const amnesty = rows.filter(r => r.action === 'amnesty' && r.refused === null)
  const skipped = rows.filter(r => r.action === 'skip' && r.refused === null)
  const refused = rows.filter(r => r.refused !== null)

  const lines: string[] = [
    '',
    `PROMISE BACKFILL -- ${opts.write ? 'WRITING' : 'DRY RUN (nothing written; pass --write)'}`,
    `  base: ${opts.base}    pre-ledger cutoff: ${opts.cutoff}`,
    `  cards considered: ${rows.length}`,
    '',
    ...section(
      '  RECORDED (a commit now stands behind it)',
      records,
      r => `${r.why}  ${r.added.join(' ')}`,
      opts.verbose,
    ),
    '',
    ...tallyBy(records, r => r.why).map(([kind, n]) => `    by evidence -- ${kind}: ${n}`),
    '',
    ...section('  AMNESTY (pre_ledger: true)', amnesty, r => r.why, opts.verbose),
    '',
    ...section('  LEFT ACCUSED / untouched', skipped, r => r.why, opts.verbose),
    '',
    // Refusals are never sampled. Each one is a card the run could not read or
    // could not write, and a count alone gives nobody a way to go fix it.
    `  REFUSED (nothing written, reason given): ${refused.length}`,
    ...refused.map(r => `    ${r.id}  ${r.refused}`),
    '',
  ]
  return lines.join('\n')
}

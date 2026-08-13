/**
 * The category rows, built from a measured estimate.
 *
 * Two things the copy must carry, because getting them wrong loses data or
 * trust:
 *
 * - The delete unit is a whole UTC MONTH, not a conversation. `pruneArchivedMonth`
 *   refuses unless the live row count for a month equals its archive's, so a
 *   conversation-scoped delete cannot ride that path. The row says so.
 * - Ended is not dead. The conversation row survives a vacuum; only transcript
 *   rows older than the hot window move to cold storage, and `archive import`
 *   brings them back. That matters more than usual right now: ended
 *   conversations are no longer visible in the sidebar, so they are invisible
 *   AND about to become prunable.
 */

import { formatBytes, formatMeasuredBytes, formatRows } from './format'
import { VacuumRow } from './vacuum-row'
import type { VacuumEstimate, VacuumSelection } from './vacuum-types'

interface Props {
  estimate: VacuumEstimate
  selection: VacuumSelection
  onChange: (next: VacuumSelection) => void
}

export function VacuumRows({ estimate, selection, onChange }: Props) {
  const { bytes } = estimate
  const eligible = estimate.months.filter(m => m.eligible)
  const rows = eligible.reduce((s, m) => s + m.rows, 0)
  const ended = eligible.reduce((s, m) => s + m.endedRows, 0)
  const indexBytes = estimate.redundantIndexes.reduce((s, i) => s + i.projectedBytes, 0)

  return (
    <div className="divide-y-0">
      <VacuumRow
        label="Transcript history"
        days={selection.hotDays}
        onDaysChange={hotDays => onChange({ ...selection, hotDays })}
        checked={selection.transcripts}
        onCheckedChange={transcripts => onChange({ ...selection, transcripts })}
        detail={
          eligible.length === 0
            ? 'No month has fully aged out of the hot window yet -- nothing to archive.'
            : `${eligible.map(m => m.month).join(', ')} -- ${formatRows(rows)} rows, ${formatRows(ended)} of them from ended conversations. Exported to a verified cold archive first, then deleted. Conversations survive; 'archive import' brings the transcripts back.`
        }
        size={formatMeasuredBytes(estimate.projectedTranscriptBytes, bytes)}
        {...(eligible.length === 0 && { disabledReason: 'Whole UTC months are the delete unit, and none qualify.' })}
      />

      <VacuumRow
        label="Redundant indexes"
        checked={selection.indexes}
        onCheckedChange={indexes => onChange({ ...selection, indexes })}
        detail={
          estimate.redundantIndexes.length === 0
            ? 'No duplicate indexes found.'
            : `${estimate.redundantIndexes.map(i => i.name).join(', ')} -- duplicate column lists left by the sessions to conversations rename. Rebuildable with one CREATE INDEX.`
        }
        size={estimate.redundantIndexes.length === 0 ? '0 B' : `~${formatBytes(indexBytes)}`}
        {...(estimate.redundantIndexes.length === 0 && { disabledReason: 'Nothing to drop.' })}
      />

      {estimate.orphans.rows > 0 && (
        <VacuumRow
          label="Orphaned transcript rows"
          informational
          checked={false}
          onCheckedChange={() => {}}
          detail={`${formatRows(estimate.orphans.rows)} rows across ${estimate.orphans.conversations} deleted conversations, in ${estimate.orphans.months.join(', ')}. ${
            estimate.orphans.sweepableRows === 0
              ? 'All of them sit inside months the transcript row already covers, so they are reclaimed by it -- no separate delete, and nothing double-counted.'
              : `${formatRows(estimate.orphans.sweepableRows)} sit outside those months.`
          }`}
          size={formatMeasuredBytes(estimate.orphans.contentBytes, bytes)}
        />
      )}

      {estimate.fileSweeps
        .filter(sweep => sweep.configured)
        .map(sweep => (
          <VacuumRow
            key={sweep.key}
            label={sweep.label}
            {...(sweep.key !== 'canvas-scenes' && {
              days: selection.files[sweep.key] ?? 30,
              onDaysChange: (d: number) => onChange({ ...selection, files: { ...selection.files, [sweep.key]: d } }),
            })}
            checked={selection.files[sweep.key] !== undefined}
            onCheckedChange={on =>
              onChange({
                ...selection,
                files: { ...selection.files, [sweep.key]: on ? (selection.files[sweep.key] ?? 30) : undefined },
              })
            }
            detail={`${formatRows(sweep.matchedFiles)} of ${formatRows(sweep.files)} files match, out of ${formatBytes(sweep.bytes)} total.`}
            size={formatBytes(sweep.matchedBytes)}
          />
        ))}
    </div>
  )
}

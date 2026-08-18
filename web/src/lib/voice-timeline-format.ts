/**
 * voice-timeline-format - render a measured dictation as something that survives
 * leaving the screen.
 *
 * Same contract as `formatLatencyReport`, and for the same reason: a screenshot
 * of a timing panel cannot be grepped, diffed, or pasted into an issue, so the
 * numbers have to leave as text carrying the context that makes them mean
 * anything later -- WHEN, over WHICH transport, and warm or cold.
 */

import type { DictationRecord } from '@/hooks/voice-timeline'
import { captureGapMs, lostMs, prerollHadSpeech } from '@/hooks/voice-timeline'

function db(value: number): string {
  return value === Number.NEGATIVE_INFINITY ? 'silent' : `${value.toFixed(1)}dBFS`
}

/** The one line that answers "is that really what it's taking". */
export function verdict(record: DictationRecord): string {
  const lost = lostMs(record)
  if (lost === 0) return 'nothing lost'
  return `lost ${lost}ms of speech`
}

function rows(record: DictationRecord): string[][] {
  let prev = 0
  return record.marks.map(m => {
    const delta = m.at - prev
    prev = m.at
    return [`${m.at}ms`, m.at === 0 ? '' : `+${delta}`, m.phase, m.detail ?? '']
  })
}

/** Left-pad the two numeric columns, left-align the rest. */
function table(record: DictationRecord): string[] {
  const data = rows(record)
  const width = (col: number) => Math.max(...data.map(r => (r[col] as string).length))
  const [wAt, wDelta, wPhase] = [width(0), width(1), width(2)]
  return data.map(r =>
    `  ${(r[0] as string).padStart(wAt)}  ${(r[1] as string).padStart(wDelta)}  ${(r[2] as string).padEnd(wPhase)}  ${r[3]}`.trimEnd(),
  )
}

function summary(record: DictationRecord): string[] {
  const gap = captureGapMs(record)
  const preroll = record.prerollFrames
    ? `${record.prerollMs}ms recovered, peak ${db(record.prerollPeakDb)}` +
      ` (${prerollHadSpeech(record) ? 'contained speech' : 'room tone only'})`
    : 'none -- the mic was not warm'
  return [
    '',
    `  capture gap  ${gap}ms -- key down to first sample actually captured`,
    `  pre-roll     ${preroll}`,
    `  NET LOST     ${lostMs(record)}ms`,
  ]
}

/** One dictation, as a block. */
function formatDictation(record: DictationRecord): string {
  return [
    `dictation #${record.id}  --  ${verdict(record)}`,
    `taken    ${record.takenAt}`,
    `path     ${record.transport || '?'} / ${record.model || '?'}`,
    `mic      ${record.micWarm ? 'warm' : 'cold'}, arm ${record.armSync ? 'synchronous' : 'async'}, ${record.chars} chars out`,
    '',
    ...table(record),
    ...summary(record),
  ].join('\n')
}

/**
 * Every kept dictation, newest first, in ONE fence so a paste is a single block.
 * Fenced because these go into issues and chat, where an unfenced table reflows
 * into nonsense.
 */
export function formatDictations(records: DictationRecord[]): string {
  if (!records.length) return '```\nno dictations measured yet\n```'
  return ['```', records.map(formatDictation).join('\n\n'), '```'].join('\n')
}

/** One line per dictation for the console, so a bad press is visible without
 *  opening anything. The full tree is one `copy` away in Settings > Voice. */
export function logDictation(record: DictationRecord) {
  console.log(
    `[voice-timing] #${record.id} ${verdict(record)} -- gap=${captureGapMs(record)}ms ` +
      `preroll=${record.prerollMs}ms/${db(record.prerollPeakDb)} mic=${record.micWarm ? 'warm' : 'cold'} ` +
      `arm=${record.armSync ? 'sync' : 'async'} chars=${record.chars}`,
  )
}

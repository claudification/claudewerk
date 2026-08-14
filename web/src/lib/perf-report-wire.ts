/**
 * The "Wire payload" section of the perf report: what the panel DOWNLOADED,
 * keyed on message type, with a field-level breakdown of the fattest instance
 * of each fat type.
 *
 * This is the section that answers "is it SQL or is it size?" without a
 * hand-rolled probe -- see `payload-anatomy` for the incident that motivated it.
 */

import { formatFieldWeight } from './payload-anatomy'
import { getWireStats, totalWireBytes } from './wire-stats'

const kb = (bytes: number) => (bytes / 1024).toFixed(1)

export function buildWireSection(): string[] {
  const rows = getWireStats()
  if (rows.length === 0) return []

  const lines: string[] = [
    '## Wire payload (inbound, by message type)',
    '',
    `Total ${kb(totalWireBytes())} KB decoded since the monitor was enabled.`,
    '',
    '| Message | n | Total KB | Largest KB | Parse+route ms | First@ms | Last@ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const r of rows) {
    lines.push(
      `| ${r.type} | ${r.n} | ${kb(r.bytes)} | ${kb(r.maxBytes)} | ${r.cpuMs.toFixed(1)} | ${r.firstAtMs.toFixed(0)} | ${r.lastAtMs.toFixed(0)} |`,
    )
  }
  lines.push('')

  const dissected = rows.filter(r => r.fields && r.fields.length > 0)
  if (dissected.length > 0) {
    lines.push('### Anatomy of the fattest instance of each type', '')
    for (const r of dissected) {
      lines.push(`**${r.type}** (${kb(r.maxBytes)} KB):`)
      for (const f of r.fields ?? []) lines.push(`- ${formatFieldWeight(f)}`)
      lines.push('')
    }
  }
  return lines
}

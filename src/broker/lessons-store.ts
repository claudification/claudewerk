/**
 * Lessons Scavenger -- broker-side persistence adapter over the PeriodRecapStore.
 *
 * Bridges the dependency-injected Tier-1 loop + Tier-2 compaction to the real
 * recap store: which recaps are scavenger nightlies vs durable ledgers, how a
 * ledger is written (a recap row, so it stays searchable + viewable), and how
 * the cross-project tech registry enumerates the ledgers.
 *
 * A project's ledger has a DETERMINISTIC id derived from its URI, so each weekly
 * compaction upserts the same row (no list-scan to find it).
 */

import { createHash } from 'node:crypto'
import type { RecapMetadata } from '../shared/protocol'
import type { LessonsRecapRecord } from './lessons-compaction'
import { buildFtsFields } from './recap/period/render/metadata'
import type { PeriodRecapStore } from './recap/period/store'

/** Template the nightly scavenge runs. */
export const LESSONS_TEMPLATE_ID = 'lessons-learned'
/** created_by stamp on Tier-1 nightly lessons recaps. */
export const SCAVENGER_CREATED_BY = 'lessons-scavenger'
/** created_by stamp on Tier-2 durable per-project ledgers (internal). */
const LEDGER_CREATED_BY = 'lessons-ledger'

function ledgerId(projectUri: string): string {
  return `recap_ledger_${createHash('sha256').update(projectUri).digest('hex').slice(0, 16)}`
}

function parseMeta(raw: string | null): RecapMetadata | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as RecapMetadata
  } catch {
    return null
  }
}

/** Completed Tier-1 nightly lessons recaps for a project, oldest first. */
export function loadNightlies(store: PeriodRecapStore, projectUri: string): LessonsRecapRecord[] {
  return store
    .list({ projectUri, status: ['done'], limit: 100 })
    .filter(r => r.createdBy === SCAVENGER_CREATED_BY && r.metadataJson != null)
    .map(r => ({ id: r.id, completedAt: r.completedAt ?? r.createdAt, metadata: parseMeta(r.metadataJson) }))
    .filter((r): r is LessonsRecapRecord => r.metadata != null)
    .sort((a, b) => a.completedAt - b.completedAt)
}

/** The project's durable ledger, if one has been written. */
export function loadLedger(store: PeriodRecapStore, projectUri: string): LessonsRecapRecord | null {
  const row = store.get(ledgerId(projectUri))
  if (!row) return null
  const metadata = parseMeta(row.metadataJson)
  return metadata ? { id: row.id, completedAt: row.completedAt ?? row.createdAt, metadata } : null
}

/** Insert-or-update the project's ledger recap row from merged metadata, keeping
 *  it searchable (FTS) + viewable (markdown). */
export function saveLedger(store: PeriodRecapStore, projectUri: string, metadata: RecapMetadata, now: number): void {
  const id = ledgerId(projectUri)
  const title = `Lessons: ${shortUri(projectUri)}`
  const markdown = renderLedgerMarkdown(metadata)
  if (!store.get(id)) {
    store.insert({
      id,
      projectUri,
      periodLabel: 'custom',
      periodStart: now,
      periodEnd: now,
      timeZone: 'UTC',
      audience: 'agent',
      signalsJson: '[]',
      signalsHash: `lessons-ledger:${id}`,
      createdAt: now,
      createdBy: LEDGER_CREATED_BY,
    })
  }
  store.update(id, {
    status: 'done',
    progress: 100,
    completedAt: now,
    title,
    subtitle: metadata.subtitle ?? null,
    markdown,
    metadataJson: JSON.stringify(metadata),
  })
  store.upsertFts(id, buildFtsFields(metadata, markdown, projectUri, title))
}

/** Purge folded nightly recaps (row + FTS + tags). */
export function reapNightlies(store: PeriodRecapStore, ids: string[]): void {
  for (const id of ids) store.purge(id)
}

/** Every durable ledger across all projects -- the source for the cross-project
 *  tech registry. */
export function loadAllLedgers(
  store: PeriodRecapStore,
): Array<{ projectUri: string; metadata: RecapMetadata; createdBy?: string }> {
  const out: Array<{ projectUri: string; metadata: RecapMetadata; createdBy?: string }> = []
  for (const r of store.list({ status: ['done'], limit: 1000 })) {
    if (r.createdBy !== LEDGER_CREATED_BY) continue
    const metadata = parseMeta(r.metadataJson)
    if (!metadata) continue
    out.push({ projectUri: r.projectUri, metadata, createdBy: r.createdBy ?? undefined })
  }
  return out
}

/** Render a compact, viewable markdown body from the ledger's merged metadata.
 *  FTS reach comes from buildFtsFields (it folds item titles/details in too); this
 *  is the human/agent-readable rendering of the durable record. */
function renderLedgerMarkdown(m: RecapMetadata): string {
  const out: string[] = []
  const section = (heading: string, items: RecapMetadata['decisions'] | undefined) => {
    if (!items?.length) return
    out.push(`## ${heading}`)
    for (const it of items) {
      const tag = it.outcome ? ` _(${it.outcome})_` : ''
      out.push(it.detail ? `- **${it.title}**${tag} -- ${it.detail}` : `- **${it.title}**${tag}`)
    }
    out.push('')
  }
  if (m.discoveries.length) {
    out.push('## Lessons')
    for (const d of m.discoveries) out.push(`- ${d}`)
    out.push('')
  }
  section('Tech used', m.tech_discovered)
  section('Decisions', m.decisions)
  section('Dead ends -- do NOT retry', m.dead_ends)
  section('Gotchas', m.gotchas)
  section('Recommendations', m.recommendations)
  return out.join('\n').trim() || '_No durable lessons recorded yet._'
}

function shortUri(uri: string): string {
  const m = uri.match(/[^/]+$/)
  return m ? m[0] : uri
}

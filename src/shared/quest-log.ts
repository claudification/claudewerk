/**
 * Quest log.md -- the APPEND-ONLY baton (plan-quest-engine §3/§4e). One
 * `### <ts> <kind> [<convId>]` section per entry. The only writer is
 * `appendLogEntry`; there is DELIBERATELY no rewrite/patch path (the log can
 * never be rewritten via a manifest patch -- that is why append is its own verb).
 */

import { appendSectionLog, readSectionLog } from './md-section-log'
import { readManifest } from './quest-manifest'
import { logFile, nowIso } from './quest-paths'
import { asQuestLogKind, type QuestLogEntry } from './quest-schema'

const LOG_HEADER = '# Quest Log\n\nAppend-only intent/completion/plan/steering entries (never rewritten).\n\n'

export interface AppendLogInput {
  kind: QuestLogEntry['kind']
  convId: string
  body: string
  ts?: string
}

/** Append ONE entry to log.md (creating it with a header if needed). */
export function appendLogEntry(root: string, petname: string, input: AppendLogInput, nowMs: number): QuestLogEntry {
  if (!readManifest(root, petname)) throw new Error(`quest not found: ${petname}`)
  const entry: QuestLogEntry = {
    ts: input.ts ?? nowIso(nowMs),
    kind: asQuestLogKind(input.kind),
    convId: input.convId || 'unknown',
    body: input.body,
  }
  appendSectionLog(logFile(root, petname), LOG_HEADER, entry)
  return entry
}

/** Read every log entry in append order. Tolerates a missing/partial file. */
export function readLog(root: string, petname: string): QuestLogEntry[] {
  return readSectionLog(logFile(root, petname)).map(s => ({
    ts: s.ts,
    kind: asQuestLogKind(s.kind),
    convId: s.convId,
    body: s.body,
  }))
}

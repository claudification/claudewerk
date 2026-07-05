/**
 * Quest log.md -- the APPEND-ONLY baton (plan-quest-engine §3/§4e). One
 * `### <ts> <kind> [<convId>]` section per entry. The only writer is
 * `appendLogEntry`; there is DELIBERATELY no rewrite/patch path (the log can
 * never be rewritten via a manifest patch -- that is why append is its own verb).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readManifest } from './quest-manifest'
import { logFile, nowIso } from './quest-paths'
import { asQuestLogKind, type QuestLogEntry } from './quest-schema'

const LOG_HEADER = '# Quest Log\n\nAppend-only intent/completion/plan/steering entries (never rewritten).\n\n'

function renderLogEntry(e: QuestLogEntry): string {
  return [`### ${e.ts} ${e.kind} [${e.convId}]`, '', e.body.trim() || '_no body_', ''].join('\n')
}

export interface AppendLogInput {
  kind: QuestLogEntry['kind']
  convId: string
  body: string
  ts?: string
}

/** Append ONE entry to log.md (creating it with a header if needed). */
export function appendLogEntry(root: string, petname: string, input: AppendLogInput, nowMs: number): QuestLogEntry {
  if (!readManifest(root, petname)) throw new Error(`quest not found: ${petname}`)
  const file = logFile(root, petname)
  const entry: QuestLogEntry = {
    ts: input.ts ?? nowIso(nowMs),
    kind: asQuestLogKind(input.kind),
    convId: input.convId || 'unknown',
    body: input.body,
  }
  const prefix = existsSync(file) ? readFileSync(file, 'utf8') : LOG_HEADER
  writeFileSync(file, `${prefix}${renderLogEntry(entry)}\n`, 'utf8')
  return entry
}

/** Read every log entry in append order. Tolerates a missing/partial file. */
export function readLog(root: string, petname: string): QuestLogEntry[] {
  const file = logFile(root, petname)
  if (!existsSync(file)) return []
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: QuestLogEntry[] = []
  for (const sec of content.split(/^### /m).slice(1)) {
    const nl = sec.indexOf('\n')
    const head = (nl === -1 ? sec : sec.slice(0, nl)).match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]/)
    if (!head) continue
    const body = (nl === -1 ? '' : sec.slice(nl + 1)).trim()
    out.push({ ts: head[1], kind: asQuestLogKind(head[2]), convId: head[3], body: body === '_no body_' ? '' : body })
  }
  return out
}

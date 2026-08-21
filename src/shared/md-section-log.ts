/**
 * APPEND-ONLY SECTION LOG -- the storage shape shared by every baton in the
 * system: a markdown file of `### <ts> <kind> [<convId>] <tag?>` sections, only
 * ever appended to, tolerant of a half-written tail.
 *
 * Extracted because quest-log.ts and epic-log.ts had the same parser twice, and
 * a divergence between them would be silent: the reader would just skip the
 * sections it no longer recognised, so a baton would appear to have fewer
 * entries rather than fail. Neither file owns its VOCABULARY here -- each keeps
 * its own `kind` enum and coercion, since those are genuinely different.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** One parsed section, before the caller narrows `kind` to its own enum. */
export interface RawLogSection {
  ts: string
  kind: string
  convId: string
  /**
   * Optional trailing token on the header line. ONE token, deliberately, and it
   * stays one: epic batons need two ids in it and COMPOSE them (`epic-log-tag.ts`)
   * rather than widen this header, because widening it would rewrite the parser
   * under quest logs -- which never write a tag at all -- to buy something only
   * epics use. Opaque here on purpose; the meaning belongs to the caller.
   */
  tag?: string
  body: string
}

const EMPTY_BODY = '_no body_'
/** `<ts> <kind> [<convId>]` plus an optional trailing token. */
const HEADER = /^(\S+)\s+(\S+)\s+\[([^\]]*)\](?:\s+(\S+))?/

/** Render one section. The inverse of `parseSectionLog`. */
export function renderLogSection(s: RawLogSection): string {
  const head = `### ${s.ts} ${s.kind} [${s.convId}]${s.tag ? ` ${s.tag}` : ''}`
  return [head, '', s.body.trim() || EMPTY_BODY, ''].join('\n')
}

/** Parse a whole log file's content. Unparseable sections are skipped, not thrown. */
function parseSectionLog(content: string): RawLogSection[] {
  const out: RawLogSection[] = []
  for (const sec of content.split(/^### /m).slice(1)) {
    const nl = sec.indexOf('\n')
    const head = (nl === -1 ? sec : sec.slice(0, nl)).match(HEADER)
    if (!head) continue
    const body = (nl === -1 ? '' : sec.slice(nl + 1)).trim()
    out.push({
      ts: head[1],
      kind: head[2],
      convId: head[3],
      ...(head[4] ? { tag: head[4] } : {}),
      body: body === EMPTY_BODY ? '' : body,
    })
  }
  return out
}

/** Read + parse a log file. A missing or unreadable file is an empty log. */
export function readSectionLog(file: string): RawLogSection[] {
  if (!existsSync(file)) return []
  try {
    return parseSectionLog(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Append one section, creating the file with `header` when it does not exist.
 * Read-then-write rather than an append handle: these files are small, written
 * rarely, and a torn append is far worse than a slow one.
 */
export function appendSectionLog(file: string, header: string, section: RawLogSection): void {
  const prefix = existsSync(file) ? readFileSync(file, 'utf8') : header
  writeFileSync(file, `${prefix}${renderLogSection(section)}\n`, 'utf8')
}

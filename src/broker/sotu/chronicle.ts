/**
 * SOTU chronicle file IO (Layer 2).
 *
 * The chronicle is the distilled SOTU, persisted as a pair:
 *   chronicle.json  the structured truth (NOW / JUST-DONE / git-fabric)
 *   chronicle.md    a rendered human view, derived from the JSON
 *
 * Both are overwritten in place on every distill (no GC, no orphans). The JSON
 * is authoritative; the markdown is a convenience render. Reading before any
 * distill returns an empty chronicle -- the free queue still renders on top.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chronicleJsonPath, chronicleMdPath } from './paths'
import { type Chronicle, emptyChronicle } from './types'

/** Write the structured chronicle (and a derived markdown render) for a project. */
export function writeChronicle(slug: string, chronicle: Chronicle): void {
  writeFileSync(chronicleJsonPath(slug), `${JSON.stringify(chronicle, null, 2)}\n`)
  writeFileSync(chronicleMdPath(slug), renderChronicleMd(chronicle))
}

/** Read the structured chronicle, or an empty chronicle if none stored yet.
 *  A torn/unreadable file degrades to empty rather than throwing. */
export function readChronicle(slug: string): Chronicle {
  const p = chronicleJsonPath(slug)
  if (!existsSync(p)) return emptyChronicle()
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Chronicle
  } catch {
    return emptyChronicle()
  }
}

/** Read the rendered markdown, or null if no chronicle has been written. */
export function readChronicleMd(slug: string): string | null {
  const p = chronicleMdPath(slug)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** Deterministic markdown render of a chronicle. Pure -- the distill engine
 *  (Phase 4) writes the narrative; this just lays out the sections. */
export function renderChronicleMd(c: Chronicle): string {
  const lines: string[] = ['# State of the Union', '']
  if (c.narrative.trim()) {
    lines.push(c.narrative.trim(), '')
  }
  if (c.now.length) {
    lines.push('## Now', '')
    for (const e of c.now) lines.push(`- ${e.title ? `**${e.title}** -- ` : ''}${e.detail}`)
    lines.push('')
  }
  if (c.justDone.length) {
    lines.push('## Just done', '')
    for (const e of c.justDone) lines.push(`- ${e.title ? `**${e.title}** -- ` : ''}${e.detail}`)
    lines.push('')
  }
  return lines.join('\n')
}

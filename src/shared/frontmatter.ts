/**
 * YAML-frontmatter parse + serialize for markdown-with-frontmatter artifacts.
 *
 * Deliberately a tiny line-oriented subset, NOT a full YAML implementation:
 * the artifact files (project board tasks, nightshift run/task files) are
 * machine-written and machine-read, so we only support flat `key: value`
 * scalars and inline `[a, b, c]` arrays. This is the single source of truth
 * for that subset -- project-store.ts and nightshift-store.ts both use it so
 * the on-disk format can never drift between them.
 */

export interface Frontmatter {
  meta: Record<string, unknown>
  body: string
}

/**
 * Split `---\n...\n---\n<body>` into parsed frontmatter + trimmed body.
 * Files with no frontmatter block return `{ meta: {}, body: content }`.
 *
 * Values: bare scalars are kept as strings (callers coerce). `[a, b]` becomes
 * a string array. No nesting, no multi-line values, no quoting rules.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let val: unknown = line.slice(idx + 1).trim()
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    }
    meta[key] = val
  }
  return { meta, body: match[2].trim() }
}

function serializeValue(val: unknown): string | null {
  if (val === undefined || val === null) return null
  if (Array.isArray(val)) return `[${val.map(v => String(v)).join(', ')}]`
  if (typeof val === 'boolean' || typeof val === 'number') return String(val)
  return String(val)
}

/**
 * Render `{ key: value }` + body back to `---\n...\n---\n\n<body>\n`. Insertion
 * order of `meta` is preserved (callers control field order). `undefined` /
 * `null` values are skipped; arrays render inline; numbers/booleans render bare.
 * Strings are written verbatim (the subset has no escaping -- keep values on
 * one line and free of leading `[`).
 */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, val] of Object.entries(meta)) {
    const rendered = serializeValue(val)
    if (rendered === null) continue
    lines.push(`${key}: ${rendered}`)
  }
  lines.push('---')
  lines.push('')
  lines.push(body)
  return `${lines.join('\n')}\n`
}

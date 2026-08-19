/**
 * THE STATUS — repair for tool-call markup that leaked into a text field.
 *
 * WHY THIS EXISTS (2026-08-18, observed live): an agent emitted a set_status
 * call mixing the two parameter syntaxes -- correct tags for the first fields,
 * then bare `<parameter name="notes">` for later ones. Only the correct form is
 * parsed as a parameter, so the closing tag and EVERY later field were swallowed
 * into the preceding string. The result: `pending` contained a wall of raw XML,
 * and `notes` / `caveats` silently never arrived.
 *
 * That failure is invisible at the call site and lands directly on the handoff
 * card the user reads -- the worst place for garbage. So rather than trust the
 * emitter, split the debris back out.
 *
 * Deliberately NARROW. It only recognises the exact shape of this leak (a
 * closing tag for the field being written, followed by sibling parameter
 * blocks). Arbitrary XML in prose is left alone: status fields are markdown and
 * a user may legitimately paste a snippet containing tags.
 */

/** Fields that carry markdown and can therefore absorb a leak. */
const STATUS_TEXT_FIELDS = ['done', 'pending', 'caveats', 'blocked', 'notes'] as const
export type StatusTextField = (typeof STATUS_TEXT_FIELDS)[number]

const FIELD_SET: ReadonlySet<string> = new Set(STATUS_TEXT_FIELDS)

export interface RepairResult {
  /** Field values recovered from the leak, keyed by name. */
  fields: Partial<Record<StatusTextField, string>>
  /** True when debris was found and removed. */
  repaired: boolean
}

/**
 * `</field>` followed by one or more `<parameter name="x">…</parameter>` blocks.
 * Anchored to the END of the value: a leak always runs to the end of the string,
 * because everything after it was absorbed.
 */
const LEAK_RE = /<\/(?:antml:)?parameter>\s*(?=<(?:antml:)?parameter\s)|<\/([a-z_]+)>\s*(?=<(?:antml:)?parameter\s)/i
const BLOCK_RE = /<(?:antml:)?parameter\s+name="([a-z_]+)"\s*>([\s\S]*?)(?:<\/(?:antml:)?parameter>|$)/gi

/**
 * Split leaked sibling fields out of one field's value.
 *
 * Returns the cleaned value for the field itself plus anything recovered. When
 * there is no leak the value is returned untouched and `repaired` is false.
 */
export function repairStatusField(_field: StatusTextField, raw: string): { value: string } & RepairResult {
  const cut = raw.search(LEAK_RE)
  if (cut < 0) return { value: raw, fields: {}, repaired: false }

  const head = raw.slice(0, cut).trimEnd()
  const tail = raw.slice(cut)
  const fields: Partial<Record<StatusTextField, string>> = {}

  BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null = BLOCK_RE.exec(tail)
  while (m) {
    const name = m[1].toLowerCase()
    const body = m[2].trim()
    // Never let a leak overwrite a field the caller also passed properly.
    if (FIELD_SET.has(name) && body && !(name in fields)) fields[name as StatusTextField] = body
    m = BLOCK_RE.exec(tail)
  }

  return { value: head, fields, repaired: true }
}

/**
 * Repair a whole params bag. Properly-passed fields always win over recovered
 * ones -- recovery is a fallback for what the parser dropped, never an override.
 */
export function repairStatusParams(params: Record<string, unknown>): RepairResult & {
  params: Record<string, unknown>
} {
  const out = { ...params }
  const recovered: Partial<Record<StatusTextField, string>> = {}
  let repaired = false

  for (const field of STATUS_TEXT_FIELDS) {
    const raw = out[field]
    if (typeof raw !== 'string') continue
    const res = repairStatusField(field, raw)
    if (!res.repaired) continue
    repaired = true
    out[field] = res.value
    for (const [k, v] of Object.entries(res.fields)) {
      if (!(k in recovered)) recovered[k as StatusTextField] = v
    }
  }

  for (const [k, v] of Object.entries(recovered)) {
    const existing = out[k]
    if (typeof existing !== 'string' || !existing.trim()) out[k] = v
  }

  return { params: out, fields: recovered, repaired }
}

/**
 * Row parsers: the `-`, `_` and `%` lines. Split out of parse.ts so the line
 * loop there stays a thin dispatch and both files stay readable.
 *
 * Every function here is total: a malformed row records a warning on the block
 * and returns, never throws.
 */
import type { AnvilBlock, AnvilOption, FieldType } from './types'
import { FIELD_TYPES } from './types'

const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES)

/** Split on unescaped pipes, then unescape. Trims each cell. */
function cells(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

/** Trailing `key=value` cells on an option row. Order-independent. */
const CELL_SETTERS: Record<string, (opt: AnvilOption, val: string) => void> = {
  img: (o, v) => {
    o.img = v
  },
  font: (o, v) => {
    o.font = v
  },
  sample: (o, v) => {
    o.sample = v
  },
  swatch: (o, v) => {
    o.swatch = v
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
  },
}

const CELL_KV = /^(img|swatch|font|sample)\s*=\s*(.*)$/i

/** `- [!]value | Label | hint | img=… | swatch=… | font=… | sample=…` */
export function parseOption(rest: string, block: AnvilBlock): void {
  const parts = cells(rest)
  let head = parts.shift() ?? ''
  const danger = head.startsWith('!')
  if (danger) head = head.slice(1).trim()
  if (!head) {
    block.warnings.push('option row with no value')
    return
  }

  const opt: AnvilOption = { value: head, label: head }
  if (danger) opt.danger = true

  const positional: string[] = []
  for (const cell of parts) {
    const kv = CELL_KV.exec(cell)
    const setter = kv ? CELL_SETTERS[(kv[1] ?? '').toLowerCase()] : undefined
    if (!setter) {
      positional.push(cell)
      continue
    }
    setter(opt, (kv?.[2] ?? '').replace(/^["']|["']$/g, '').trim())
  }
  if (positional[0]) opt.label = positional[0]
  if (positional[1]) opt.hint = positional[1]
  block.options.push(opt)
}

function titleCase(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase())
}

/** `_ name[*] | type | Label | placeholder` */
export function parseField(rest: string, block: AnvilBlock): void {
  const [rawName = '', rawType = '', label = '', placeholder = ''] = cells(rest)
  const required = rawName.endsWith('*')
  const name = (required ? rawName.slice(0, -1) : rawName).trim()
  if (!name) {
    block.warnings.push('field row with no name')
    return
  }
  const lower = rawType.toLowerCase()
  const known = FIELD_TYPE_SET.has(lower)
  if (rawType && !known) block.warnings.push(`unknown field type "${rawType}", using text`)
  block.fields.push({
    name,
    type: known ? (lower as FieldType) : 'text',
    label: label || titleCase(name),
    placeholder: placeholder || undefined,
    required,
  })
}

/** `% name | leftPole | rightPole | default` */
export function parseDial(rest: string, block: AnvilBlock, steps: number): void {
  const [name = '', left = '', right = '', def = ''] = cells(rest)
  if (!name) {
    block.warnings.push('scale row with no name')
    return
  }
  const parsed = Number.parseInt(def, 10)
  const fallback = Math.ceil(steps / 2)
  const value = Math.min(steps, Math.max(1, Number.isFinite(parsed) ? parsed : fallback))
  block.dials.push({ name, left: left || 'Less', right: right || 'More', value })
}

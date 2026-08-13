/**
 * The ANVIL parser. Line-oriented, one level of nesting, no lookahead.
 *
 * TOTAL BY CONTRACT: this function has no throw path. It parses agent-authored
 * text that arrives token by token, so every malformed shape degrades to
 * something renderable plus a warning. A throw here white-screens the whole
 * transcript, which is why parse.test.ts fuzzes every truncation of every
 * fixture.
 */
import {
  ANVIL_KINDS,
  type AnvilBlock,
  type AnvilDoc,
  type AnvilKind,
  type AnvilOption,
  FIELD_TYPES,
  type FieldType,
} from './types'

const KIND_SET = new Set<string>(ANVIL_KINDS)
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

/** `key=value`, `key="quoted value"`, or a bare `key` meaning true. */
function parseAttrs(s: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {}
  const re = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  for (const m of s.matchAll(re)) {
    const key = m[1]
    if (!key) continue
    const val = m[2] ?? m[3] ?? m[4]
    attrs[key] = val === undefined ? true : val
  }
  return attrs
}

/** Stable, content-derived id. Must not depend on position: streaming reorders. */
function deriveId(kind: string, body: string): string {
  const norm = `${kind}\n${body.replace(/\s+/g, ' ').trim()}`
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `a${(h >>> 0).toString(16).padStart(8, '0')}`
}

function blank(kind: AnvilKind): AnvilBlock {
  return {
    kind,
    id: '',
    derivedId: true,
    prompt: '',
    subtext: '',
    attrs: {},
    options: [],
    fields: [],
    dials: [],
    prose: '',
    warnings: [],
  }
}

/** `- [!]value | Label | hint | img=… | swatch=… | font=… | sample=…` */
function parseOption(rest: string, block: AnvilBlock): void {
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
    const kv = cell.match(/^(img|swatch|font|sample)\s*=\s*(.*)$/i)
    if (!kv) {
      positional.push(cell)
      continue
    }
    const key = (kv[1] ?? '').toLowerCase()
    const val = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim()
    if (key === 'swatch')
      opt.swatch = val
        .split(',')
        .map(c => c.trim())
        .filter(Boolean)
    else if (key === 'img') opt.img = val
    else if (key === 'font') opt.font = val
    else opt.sample = val
  }
  if (positional[0]) opt.label = positional[0]
  if (positional[1]) opt.hint = positional[1]
  block.options.push(opt)
}

/** `_ name[*] | type | Label | placeholder` */
function parseField(rest: string, block: AnvilBlock): void {
  const [rawName = '', rawType = '', label = '', placeholder = ''] = cells(rest)
  const required = rawName.endsWith('*')
  const name = (required ? rawName.slice(0, -1) : rawName).trim()
  if (!name) {
    block.warnings.push('field row with no name')
    return
  }
  const lower = rawType.toLowerCase()
  const type: FieldType = FIELD_TYPE_SET.has(lower) ? (lower as FieldType) : 'text'
  if (rawType && !FIELD_TYPE_SET.has(lower)) {
    block.warnings.push(`unknown field type "${rawType}", using text`)
  }
  block.fields.push({
    name,
    type,
    label: label || name.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase()),
    placeholder: placeholder || undefined,
    required,
  })
}

/** `% name | leftPole | rightPole | default` */
function parseDial(rest: string, block: AnvilBlock, steps: number): void {
  const [name = '', left = '', right = '', def = ''] = cells(rest)
  if (!name) {
    block.warnings.push('scale row with no name')
    return
  }
  const parsed = Number.parseInt(def, 10)
  const mid = Math.ceil(steps / 2)
  const value = Math.min(steps, Math.max(1, Number.isFinite(parsed) ? parsed : mid))
  block.dials.push({ name, left: left || 'Less', right: right || 'More', value })
}

function finish(block: AnvilBlock, body: string[]): AnvilBlock {
  const authored = block.attrs.id
  if (typeof authored === 'string' && authored) {
    block.id = authored
    block.derivedId = false
  } else {
    block.id = deriveId(block.kind, body.join('\n'))
  }
  if (block.options.length > 12) {
    block.warnings.push(`${block.options.length} options is past the point a human scans; use @input`)
  }
  return block
}

export function parseAnvil(source: string, opts: { partial?: boolean } = {}): AnvilDoc {
  const doc: AnvilDoc = { blocks: [], partial: opts.partial === true }
  let block: AnvilBlock | null = null
  let body: string[] = []
  let steps = 5

  const close = (): void => {
    if (block) doc.blocks.push(finish(block, body))
    block = null
    body = []
  }

  for (const rawLine of String(source ?? '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('@')) {
      close()
      const m = line.match(/^@(\w+)\s*(.*)$/)
      const rawKind = (m?.[1] ?? '').toLowerCase()
      const kind: AnvilKind = KIND_SET.has(rawKind) ? (rawKind as AnvilKind) : 'note'
      block = blank(kind)
      block.attrs = parseAttrs(m?.[2] ?? '')
      if (!KIND_SET.has(rawKind)) {
        block.attrs.tone = 'warn'
        block.prose = line
        block.warnings.push(`unknown block "@${rawKind || '?'}"`)
      }
      steps = 5
      const rawSteps = block.attrs.steps
      if (typeof rawSteps === 'string') {
        const n = Number.parseInt(rawSteps, 10)
        if (Number.isFinite(n) && n >= 2 && n <= 11) steps = n
        else block.warnings.push(`steps="${rawSteps}" out of range, using 5`)
      }
      continue
    }

    // Content before any @ header is an implicit note.
    if (!block) {
      block = blank('note')
      body = []
    }
    body.push(line)

    const sigil = line.charAt(0)
    const rest = line.slice(1).trim()
    if (sigil === '?') block.prompt = block.prompt ? `${block.prompt}\n${rest}` : rest
    else if (sigil === ':') block.subtext = block.subtext ? `${block.subtext} ${rest}` : rest
    else if (sigil === '-') parseOption(rest, block)
    else if (sigil === '_') parseField(rest, block)
    else if (sigil === '%') parseDial(rest, block, steps)
    else if (sigil === '>') block.prose = block.prose ? `${block.prose}\n${rest}` : rest
    else block.prompt = block.prompt ? `${block.prompt}\n${line}` : line
  }

  close()
  return doc
}

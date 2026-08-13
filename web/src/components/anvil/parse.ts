/**
 * The ANVIL parser. Line-oriented, one level of nesting, no lookahead.
 *
 * TOTAL BY CONTRACT: this function has no throw path. It parses agent-authored
 * text that arrives token by token, so every malformed shape degrades to
 * something renderable plus a warning. A throw here white-screens the whole
 * transcript, which is why parse.test.ts fuzzes every truncation of every
 * fixture.
 *
 * Row parsing lives in rows.ts; this file is the line dispatch and the block
 * assembly, nothing else.
 */
import { parseDial, parseField, parseOption } from './rows'
import { ANVIL_KINDS, type AnvilBlock, type AnvilDoc, type AnvilKind } from './types'

const KIND_SET = new Set<string>(ANVIL_KINDS)
const DEFAULT_STEPS = 5
const HEADER = /^@(\w+)\s*(.*)$/
const ATTR = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g

/** `key=value`, `key="quoted value"`, or a bare `key` meaning true. */
function parseAttrs(s: string): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {}
  for (const m of s.matchAll(ATTR)) {
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

function join(prev: string, next: string, sep: string): string {
  return prev ? `${prev}${sep}${next}` : next
}

interface Cursor {
  block: AnvilBlock
  steps: number
}

/**
 * Strategy map, not an if-else chain: one entry per sigil. A line whose first
 * character is not a key here folds into the prompt (see the fallback in run),
 * so a forgotten sigil renders slightly wrong instead of vanishing.
 */
const LINES: Record<string, (rest: string, cur: Cursor) => void> = {
  '?': (rest, { block }) => {
    block.prompt = join(block.prompt, rest, '\n')
  },
  ':': (rest, { block }) => {
    block.subtext = join(block.subtext, rest, ' ')
  },
  '>': (rest, { block }) => {
    block.prose = join(block.prose, rest, '\n')
  },
  '-': (rest, { block }) => parseOption(rest, block),
  _: (rest, { block }) => parseField(rest, block),
  '%': (rest, cur) => parseDial(rest, cur.block, cur.steps),
}

/** Reads `steps=` off a freshly opened block, warning when out of range. */
function readSteps(block: AnvilBlock): number {
  const raw = block.attrs.steps
  if (typeof raw !== 'string') return DEFAULT_STEPS
  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 2 && n <= 11) return n
  block.warnings.push(`steps="${raw}" out of range, using ${DEFAULT_STEPS}`)
  return DEFAULT_STEPS
}

function openBlock(line: string): Cursor {
  const m = HEADER.exec(line)
  const rawKind = (m?.[1] ?? '').toLowerCase()
  const known = KIND_SET.has(rawKind)
  const block = blank(known ? (rawKind as AnvilKind) : 'note')
  block.attrs = parseAttrs(m?.[2] ?? '')
  if (!known) {
    block.attrs.tone = 'warn'
    block.prose = line
    block.warnings.push(`unknown block "@${rawKind || '?'}"`)
  }
  return { block, steps: readSteps(block) }
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
  let cur: Cursor | null = null
  let body: string[] = []

  const close = (): void => {
    if (cur) doc.blocks.push(finish(cur.block, body))
    cur = null
    body = []
  }

  for (const rawLine of String(source ?? '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('@')) {
      close()
      cur = openBlock(line)
      continue
    }

    // Content before any @ header is an implicit note.
    if (!cur) cur = { block: blank('note'), steps: DEFAULT_STEPS }
    body.push(line)

    const handler = LINES[line.charAt(0)]
    if (handler) handler(line.slice(1).trim(), cur)
    else cur.block.prompt = join(cur.block.prompt, line, '\n')
  }

  close()
  return doc
}

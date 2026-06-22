/**
 * Parse the LLM's YAML-frontmatter + markdown-body output. We do NOT
 * use a full YAML library to keep the dep surface small. The metadata
 * we extract is a known shape (lists of strings, lists of objects with
 * known fields) so a small hand-rolled parser is enough.
 */

// Wire types live in shared/protocol.ts (single source of truth -- they are
// exposed on PeriodRecapDoc). RecapMetadata is re-exported here so existing
// broker-side imports (`from './parse-recap'`) keep working; RecapItem is
// imported for internal use only (consumers import it from shared/protocol).
export type { RecapMetadata } from '../../../../shared/protocol'

import type { RecapItem, RecapMetadata } from '../../../../shared/protocol'

export interface ParsedRecap {
  metadata: RecapMetadata
  body: string
}

export class RecapParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message)
    this.name = 'RecapParseError'
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

export function parseRecapOutput(raw: string): ParsedRecap {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) {
    throw new RecapParseError('LLM output is missing the YAML frontmatter block', raw)
  }
  const yaml = match[1]
  const body = match[2].trim()
  const metadata = parseMetadata(yaml)
  return { metadata, body }
}

const SIMPLE_LIST_FIELDS = [
  'keywords',
  'hashtags',
  'goals',
  'discoveries',
  'side_effects',
  'open_questions',
  'stakeholders',
] as const
// Pillar F retrospect fields (went_well/went_badly/recommendations) are item
// lists too, but OPTIONAL -- omitted from makeEmptyMetadata so they're absent on
// non-retrospect recaps, and only populated here when Opus actually emits them.
const ITEM_LIST_FIELDS = [
  'features',
  'bugs',
  'fixes',
  'incidents',
  'decisions',
  'dead_ends',
  'gotchas',
  'frustrations',
  'tech_discovered',
  'went_well',
  'went_badly',
  'recommendations',
] as const

// fallow-ignore-next-line complexity
function parseMetadata(yaml: string): RecapMetadata {
  const result = makeEmptyMetadata()
  const sections = splitYamlIntoSections(yaml)
  for (const [key, value] of sections) {
    if (key === 'subtitle') {
      result.subtitle = stripQuotes(value.trim())
      continue
    }
    if (SIMPLE_LIST_FIELDS.includes(key as (typeof SIMPLE_LIST_FIELDS)[number])) {
      const list = parseStringList(value)
      ;(result as unknown as Record<string, unknown>)[key] = list
      continue
    }
    if (ITEM_LIST_FIELDS.includes(key as (typeof ITEM_LIST_FIELDS)[number])) {
      ;(result as unknown as Record<string, unknown>)[key] = parseItemList(value)
    }
  }
  return result
}

function makeEmptyMetadata(): RecapMetadata {
  return {
    keywords: [],
    hashtags: [],
    goals: [],
    discoveries: [],
    side_effects: [],
    features: [],
    bugs: [],
    fixes: [],
    incidents: [],
    decisions: [],
    dead_ends: [],
    gotchas: [],
    frustrations: [],
    open_questions: [],
    stakeholders: [],
  }
}

// fallow-ignore-next-line complexity
function splitYamlIntoSections(yaml: string): Array<[string, string]> {
  const sections: Array<[string, string]> = []
  const lines = yaml.split(/\r?\n/)
  let currentKey: string | null = null
  let currentValue: string[] = []
  for (const line of lines) {
    const topLevelMatch = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/)
    if (topLevelMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (currentKey) sections.push([currentKey, currentValue.join('\n')])
      currentKey = topLevelMatch[1]
      currentValue = topLevelMatch[2] ? [topLevelMatch[2]] : []
    } else if (currentKey) {
      currentValue.push(line)
    }
  }
  if (currentKey) sections.push([currentKey, currentValue.join('\n')])
  return sections
}

function parseStringList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) return parseInlineList(trimmed)
  return parseBulletList(value)
}

function parseInlineList(value: string): string[] {
  const inner = value.replace(/^\[/, '').replace(/\]\s*$/, '')
  return inner
    .split(',')
    .map(s => stripQuotes(s.trim()))
    .filter(Boolean)
}

function parseBulletList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
    .map(stripQuotes)
}

interface PartialItem {
  title?: string
  detail?: string
  conversations?: string[]
  commits?: string[]
  inferred?: boolean
  outcome?: 'success' | 'failure' | 'mixed'
}

/** Coerce a free-text outcome value to the enum, or undefined. */
function parseOutcome(raw: string): 'success' | 'failure' | 'mixed' | undefined {
  const v = stripQuotes(raw.trim()).toLowerCase()
  if (v === 'success' || v === 'failure' || v === 'mixed') return v
  return undefined
}

// fallow-ignore-next-line complexity
function parseItemList(value: string): RecapItem[] {
  const items: RecapItem[] = []
  const lines = value.split(/\r?\n/)
  let current: PartialItem | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const itemStart = line.match(/^\s*-\s+(?:title:\s*)?(.+)$/)
    if (itemStart) {
      if (current?.title) items.push(toItem(current))
      const head = itemStart[1].trim()
      // FLOW-MAP form: `- {title: X, detail: "...", conversations: [...]}`. This is
      // what the reduce/oneshot LLM actually emits (FRONTMATTER_SPEC shows items as
      // `{title, detail?, ...}`), NOT the block form the rest of this loop handles.
      // A flow-map may wrap across lines, so accumulate until the braces balance.
      if (head.startsWith('{')) {
        let buf = head
        while (!flowMapBalanced(buf) && i + 1 < lines.length) {
          i++
          buf += `\n${lines[i]}`
        }
        current = parseFlowMapItem(buf)
        continue
      }
      current = titleToPartial(head)
      continue
    }
    if (!current) continue
    const subMatch = line.match(/^\s+([a-zA-Z_]+)\s*:\s*(.+)$/)
    if (!subMatch) continue
    const [, key, rawVal] = subMatch
    assignItemField(current, key, rawVal.trim())
  }
  if (current?.title) items.push(toItem(current))
  return items
}

/** True once `s` holds a complete, brace-balanced flow-map (quote/bracket aware). */
function flowMapBalanced(s: string): boolean {
  return splitTopLevel(stripBraces(s)) !== null
}

/** Strip the outermost {...} wrapper, returning the inner content. Returns the
 *  input unchanged when it is not yet a closed brace pair. */
function stripBraces(s: string): string {
  const open = s.indexOf('{')
  const close = s.lastIndexOf('}')
  if (open === -1 || close <= open) return s
  return s.slice(open + 1, close)
}

/**
 * Parse one YAML flow-map item: `{title: X, detail: "...", conversations: [a, b]}`.
 * Values are YAML-flow (unquoted scalars, quoted strings, inline `[...]` lists),
 * NOT strict JSON, so we split on TOP-LEVEL commas (ignoring commas inside quotes /
 * brackets / nested braces) and parse each `key: value` pair.
 */
function parseFlowMapItem(raw: string): PartialItem {
  const fields = splitTopLevel(stripBraces(raw)) ?? []
  const item: PartialItem = {}
  for (const field of fields) {
    const idx = field.indexOf(':')
    if (idx === -1) continue
    const key = field.slice(0, idx).trim()
    const val = field.slice(idx + 1).trim()
    assignItemField(item, key, val)
  }
  return item
}

/** Assign one parsed `key: value` pair onto a PartialItem. Shared by the block
 *  and flow-map item parsers so the field dispatch lives in ONE place. `val` is
 *  pre-trimmed; unknown keys are ignored. */
function assignItemField(target: PartialItem, key: string, val: string): void {
  switch (key) {
    case 'title':
      Object.assign(target, titleToPartial(val))
      break
    case 'detail':
      target.detail = stripQuotes(val)
      break
    case 'conversations':
      target.conversations = parseInlineList(val)
      break
    case 'commits':
      target.commits = parseInlineList(val)
      break
    case 'inferred':
      target.inferred = /^(true|yes)$/i.test(stripQuotes(val))
      break
    case 'outcome':
      target.outcome = parseOutcome(val)
      break
  }
}

/**
 * Split `s` on top-level commas, respecting quotes, [], and nested {}. Returns
 * null when the structure is unbalanced (an unclosed bracket/brace/quote) -- the
 * signal flowMapBalanced uses to keep accumulating wrapped lines.
 */
// fallow-ignore-next-line complexity
function splitTopLevel(s: string): string[] | null {
  const out: string[] = []
  let depth = 0
  let inString: '"' | "'" | null = null
  let escaped = false
  let cur = ''
  for (const ch of s) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (inString) {
      cur += ch
      if (ch === '\\') escaped = true
      else if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      cur += ch
      continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (depth !== 0 || inString) return null
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Strip a leading `[inferred]` marker off a title and flag the item. */
function titleToPartial(raw: string): PartialItem {
  const title = stripQuotes(raw)
  const m = title.match(/^\[inferred\]\s*(.+)$/i)
  if (m) return { title: m[1].trim(), inferred: true }
  return { title }
}

// fallow-ignore-next-line complexity
function toItem(p: PartialItem): RecapItem {
  return {
    title: p.title ?? '',
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.conversations?.length ? { conversations: p.conversations } : {}),
    ...(p.commits?.length ? { commits: p.commits } : {}),
    ...(p.inferred ? { inferred: true } : {}),
    ...(p.outcome ? { outcome: p.outcome } : {}),
  }
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

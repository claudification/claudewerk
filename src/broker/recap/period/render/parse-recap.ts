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
const ITEM_LIST_FIELDS = ['features', 'bugs', 'fixes', 'incidents', 'decisions', 'dead_ends', 'gotchas'] as const

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
}

// fallow-ignore-next-line complexity
function parseItemList(value: string): RecapItem[] {
  const items: RecapItem[] = []
  const lines = value.split(/\r?\n/)
  let current: PartialItem | null = null
  for (const line of lines) {
    const itemStart = line.match(/^\s*-\s+(?:title:\s*)?(.+)$/)
    if (itemStart) {
      if (current?.title) items.push(toItem(current))
      current = titleToPartial(itemStart[1].trim())
      continue
    }
    if (!current) continue
    const subMatch = line.match(/^\s+([a-zA-Z_]+)\s*:\s*(.+)$/)
    if (!subMatch) continue
    const [, key, rawVal] = subMatch
    if (key === 'title') Object.assign(current, titleToPartial(rawVal.trim()))
    if (key === 'detail') current.detail = stripQuotes(rawVal.trim())
    if (key === 'conversations') current.conversations = parseInlineList(rawVal.trim())
    if (key === 'commits') current.commits = parseInlineList(rawVal.trim())
    if (key === 'inferred') current.inferred = /^(true|yes)$/i.test(stripQuotes(rawVal.trim()))
  }
  if (current?.title) items.push(toItem(current))
  return items
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
  }
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/**
 * Claude Code transcript adapter: CC's JSONL session format <-> the normalized
 * model. This is the ONLY file that knows CC's wire shape (uuid/parentUuid
 * chain, message.content block types, the `type` discriminator).
 *
 * Serialize is deliberately dumb: it re-emits each entry's `raw` and only
 * rebuilds `message.content` from the parsed blocks. Id/parent/session rewrites
 * are the compactor's job (it writes them into `raw`), which keeps a no-op
 * round-trip lossless.
 */

import {
  type ContentBlock,
  type Entry,
  type EntryRole,
  isMessageEntry,
  type Transcript,
  type TranscriptAdapter,
} from './model'

const MESSAGE_TYPES = new Set(['user', 'assistant'])

type RawBlock = Record<string, unknown>

const BLOCK_PARSERS: Record<string, (raw: RawBlock) => ContentBlock> = {
  text: raw => ({ kind: 'text', text: String(raw.text ?? '') }),
  thinking: raw => ({
    kind: 'thinking',
    text: String(raw.thinking ?? ''),
    signature: raw.signature as string | undefined,
  }),
  tool_use: raw => ({ kind: 'tool_use', id: String(raw.id), name: String(raw.name), input: raw.input }),
  tool_result: raw => ({
    kind: 'tool_result',
    toolUseId: String(raw.tool_use_id),
    content: raw.content,
    isError: raw.is_error as boolean | undefined,
  }),
}

/** Unknown block kinds survive verbatim as a JSON text block (lossless). */
function parseBlock(raw: RawBlock): ContentBlock {
  return (BLOCK_PARSERS[String(raw.type)] ?? (r => ({ kind: 'text', text: JSON.stringify(r) })))(raw)
}

function parseBlocks(content: unknown): ContentBlock[] | undefined {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return undefined
  return (content as RawBlock[]).map(parseBlock)
}

function blockToWire(b: ContentBlock): Record<string, unknown> {
  switch (b.kind) {
    case 'text':
      return { type: 'text', text: b.text }
    case 'thinking':
      return { type: 'thinking', thinking: b.text, ...(b.signature !== undefined && { signature: b.signature }) }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError !== undefined && { is_error: b.isError }),
      }
  }
}

/** Re-emit user content as a bare string when that is how it arrived. */
function contentShape(original: unknown, blocks: ContentBlock[]): unknown {
  if (typeof original === 'string' && blocks.length === 1 && blocks[0].kind === 'text') {
    return blocks[0].text
  }
  return blocks.map(blockToWire)
}

function lineToEntry(obj: Record<string, unknown>): Entry {
  const type = String(obj.type ?? '')
  const entry: Entry = {
    id: (obj.uuid as string | undefined) ?? null,
    parentId: (obj.parentUuid as string | undefined) ?? null,
    type,
    raw: obj,
  }
  const message = obj.message as Record<string, unknown> | undefined
  if (MESSAGE_TYPES.has(type) && message) {
    entry.role = type as EntryRole
    entry.blocks = parseBlocks(message.content)
  }
  return entry
}

export class ClaudeCodeAdapter implements TranscriptAdapter {
  parse(raw: string): Transcript {
    const entries: Entry[] = []
    let sessionId = ''
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj.sessionId === 'string' && !sessionId) sessionId = obj.sessionId
      entries.push(lineToEntry(obj))
    }
    return { sessionId, entries }
  }

  serialize(t: Transcript): string {
    const lines = t.entries.map(e => {
      const obj = { ...e.raw }
      if (isMessageEntry(e)) {
        const message = { ...(obj.message as Record<string, unknown>) }
        message.content = contentShape((obj.message as Record<string, unknown>)?.content, e.blocks)
        obj.message = message
      }
      return JSON.stringify(obj)
    })
    return lines.length ? `${lines.join('\n')}\n` : ''
  }
}

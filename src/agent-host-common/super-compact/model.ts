/**
 * Normalized, harness-agnostic transcript model for super-compaction.
 *
 * The compactor operates ONLY on this model -- it never touches a file or knows
 * what Claude Code is. Adapters translate a concrete transcript format to/from
 * this shape and own a LOSSLESS round-trip: re-parsing a serialized transcript
 * yields the same entries it started from.
 */

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }

export type EntryRole = 'user' | 'assistant'

/**
 * One transcript entry (one JSONL line in CC). Message entries (user/assistant)
 * carry parsed `blocks`; everything else (attachments, queue ops, titles)
 * survives opaquely via `raw`.
 */
export interface Entry {
  /** Stable id within the transcript (CC: `uuid`). Null for header-ish lines. */
  id: string | null
  /** Parent link forming the conversation chain (CC: `parentUuid`). */
  parentId: string | null
  /** Wire type (CC: `type` -- 'user' | 'assistant' | 'attachment' | ...). */
  type: string
  /** Present only for message entries. */
  role?: EntryRole
  /** Parsed content; message entries only. */
  blocks?: ContentBlock[]
  /** The full original object, for lossless passthrough + re-emitted metadata. */
  raw: Record<string, unknown>
}

export interface Transcript {
  /** Session identity (CC: `sessionId`). A synthesized transcript gets a fresh one. */
  sessionId: string
  /** Entries in chain order. */
  entries: Entry[]
}

/** The ONLY place a concrete transcript format is known. */
export interface TranscriptAdapter {
  parse(raw: string): Transcript
  serialize(t: Transcript): string
}

/** Narrows to entries the compactor reasons about (those carrying blocks). */
export function isMessageEntry(e: Entry): e is Entry & { role: EntryRole; blocks: ContentBlock[] } {
  return e.blocks !== undefined && e.role !== undefined
}

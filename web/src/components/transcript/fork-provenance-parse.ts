/**
 * Pull the fork provenance out of a transcript entry's text.
 *
 * The block is emitted by the broker (src/shared/fork-provenance.ts) and rides
 * at the top of a forked session's first entry. Parsing it here lets the
 * transcript draw a proper card instead of dumping pseudo-XML plus a
 * machine-written preamble at the top of every forked conversation.
 */

export interface ForkProvenanceRef {
  conversationId: string
  conversationName?: string
  /** Everything after the block -- the fold's own preamble. */
  rest: string
}

/** Cheap pre-check so the hot path does not run a regex over every entry. */
export function hasForkProvenance(text: string): boolean {
  return text.includes('<forked from_conversation=')
}

const BLOCK = /<forked from_conversation="([^"]+)"(?:\s+from_name="((?:[^"\\]|\\.)*)")?>([\s\S]*?)<\/forked>/

export function parseForkProvenance(text: string): ForkProvenanceRef | null {
  const m = BLOCK.exec(text)
  if (!m) return null

  // from_name is JSON-escaped at render time so a quote in the title cannot
  // break the tag; undo that here.
  let conversationName: string | undefined
  if (m[2] !== undefined) {
    try {
      conversationName = JSON.parse(`"${m[2]}"`) as string
    } catch {
      conversationName = m[2]
    }
  }

  return {
    conversationId: m[1],
    conversationName: conversationName || undefined,
    rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(),
  }
}

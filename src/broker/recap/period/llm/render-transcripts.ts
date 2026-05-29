/**
 * Shared transcript rendering for the recap prompts.
 *
 * The ONESHOT human/agent prompt (prompt-builder.ts) and the CHUNKED:Intermediary
 * map prompt (chunk/map-prompt.ts) BOTH render transcripts the same way -- and the
 * chunk splitter's char accounting (split.ts `transcriptChars`) must match what is
 * actually sent. One renderer, one source of truth, so the three never drift.
 */

import type { TranscriptDigest } from '../gather/types'

/** Short, stable id for prompts (8-12 chars is enough to cite + resolve). */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

export function renderTurn(t: TranscriptDigest['turns'][number], i: number): string {
  const lines = [`  T${i + 1} USER: ${t.userPrompt}`, `  T${i + 1} ASSISTANT: ${t.assistantFinal}`]
  if (t.internals) {
    const indented = t.internals
      .split('\n')
      .map(l => `    ${l}`)
      .join('\n')
    lines.push(`  T${i + 1} INTERNALS (tool calls + errors):\n${indented}`)
  }
  return lines.join('\n')
}

export function renderTranscriptsSection(digests: TranscriptDigest[]): string {
  if (digests.length === 0) return 'TRANSCRIPTS: (none)'
  const blocks = digests.map(d => {
    const turns = d.turns.map((t, i) => renderTurn(t, i)).join('\n')
    return `### ${shortId(d.conversationId)} "${d.conversationTitle}"\n${turns || '  (no turns)'}`
  })
  return `TRANSCRIPTS:\n\n${blocks.join('\n\n')}`
}

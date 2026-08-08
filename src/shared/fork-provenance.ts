/**
 * The provenance block a forked conversation carries about its parent.
 *
 * A fork that does not know it is a fork is the failure this prevents: the
 * agent sees a digested stub or a summary, has no idea a fuller record exists,
 * and either re-derives what is already known or quietly treats the gap as
 * "nothing happened". The block says where it came from AND names the exact
 * tools that reach the original, so recovering detail is one call, not a hunt.
 *
 * Rendered broker-side (conversation identity is ours) and handed to the
 * sentinel as opaque text, so super-compact stays harness-agnostic -- it never
 * learns what a conversation or an MCP tool is.
 */

/** How much of the parent survived, which changes what is worth recovering. */
export type ForkProvenanceMode = 'full' | 'condensed' | 'summarized'

export interface ForkProvenance {
  conversationId: string
  /** Display name of the parent, for the human reading the transcript. */
  conversationName?: string
  mode: ForkProvenanceMode
}

const WHAT_SURVIVED: Record<ForkProvenanceMode, string> = {
  full: 'The history above is a complete copy of that session.',
  condensed:
    'The history above is a CONDENSED fold of that session: large tool outputs were replaced by ' +
    'a one-line stub plus a short preview, and older thinking blocks were dropped. Anything that ' +
    'looks truncated or elided is recoverable in full from the original.',
  summarized:
    "You have NOT been given that session's transcript -- only the summary below. Anything not in " +
    'the summary is still recoverable from the original.',
}

export function renderForkProvenance(p: ForkProvenance): string {
  const name = p.conversationName?.trim()
  const label = name ? `"${name}"` : 'an earlier session'
  const attr = name ? ` from_name=${JSON.stringify(name)}` : ''

  return [
    `<forked from_conversation="${p.conversationId}"${attr}>`,
    `This conversation was forked from ${label} (conversation id ${p.conversationId}).`,
    WHAT_SURVIVED[p.mode],
    '',
    'To read the original rather than guessing, use these tools -- they take the parent id directly:',
    `  search_transcripts({ conversationId: "${p.conversationId}", query: "<terms>" })`,
    `  get_transcript_context({ conversationId: "${p.conversationId}", aroundSeq: <seq from a hit> })`,
    '',
    'Do that whenever a detail matters and the record here is thin -- a folded tool result, a ' +
      'decision whose reasoning is missing, a file you are about to change blind. Do not re-derive ' +
      'work the parent already did.',
    '</forked>',
  ].join('\n')
}

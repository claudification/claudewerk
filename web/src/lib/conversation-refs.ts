/**
 * Conversation reference tokens — the `<conversation id="...">label</conversation>`
 * wrapper produced by the `:` completer.
 *
 * WHY XML instead of a bare slug: the verbatim message text is what the receiving
 * agent sees. A bare `project:slug` is ambiguous (slugs churn as conversations
 * spawn/end at a project), so the agent can mis-resolve it. Wrapping the STABLE
 * conversation id alongside the human-readable slug means the agent (and the
 * send_message tool) always have an unambiguous target, while the control panel
 * renders the slug as a compact pill in both the input box and the transcript.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the token shape. The CM6 pill
 * widget, the send-time link-grant parser, and the markdown transcript renderer
 * all build/parse through here — do NOT re-spell the regex elsewhere.
 */

/** A parsed conversation reference. */
export interface ConversationRef {
  /** Stable conversation id (the wire `SessionSummary.id` / routing id). */
  id: string
  /** Human-readable label — the compound `project:conversation-slug`. */
  label: string
  /** Byte offset of the opening `<` in the source string. */
  start: number
  /** Byte offset just past the closing `>`. */
  end: number
}

// Global, multi-match. Capture 1 = id attribute, capture 2 = label body.
// Label body is non-greedy and forbids a literal `<` so a malformed/nested tag
// can't swallow following content.
const REF_RE = /<conversation id="([^"]+)">([^<]*)<\/conversation>/g

/** Build the canonical reference token for a conversation. */
export function buildConversationRef(id: string, label: string): string {
  return `<conversation id="${id}">${label}</conversation>`
}

/** Parse every conversation reference out of `text`, in document order. */
export function parseConversationRefs(text: string): ConversationRef[] {
  const refs: ConversationRef[] = []
  REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = REF_RE.exec(text))) {
    refs.push({ id: m[1], label: m[2], start: m.index, end: m.index + m[0].length })
  }
  return refs
}

// Anchored single-match form for streaming tokenizers (e.g. the marked inline
// extension), which test the start of the remaining source. Same shape as REF_RE.
const LEADING_REF_RE = /^<conversation id="([^"]+)">([^<]*)<\/conversation>/

/** Match a conversation reference at the START of `src`, or null. */
export function matchLeadingConversationRef(src: string): { raw: string; id: string; label: string } | null {
  const m = src.match(LEADING_REF_RE)
  return m ? { raw: m[0], id: m[1], label: m[2] } : null
}

/** Distinct referenced conversation ids (order-preserving). */
export function referencedConversationIds(text: string): string[] {
  const seen = new Set<string>()
  for (const ref of parseConversationRefs(text)) seen.add(ref.id)
  return [...seen]
}

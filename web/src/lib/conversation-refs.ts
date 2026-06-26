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

import { makeXmlRefCodec } from './xml-ref'

const codec = makeXmlRefCodec('conversation')

/** Build the canonical reference token for a conversation. */
export const buildConversationRef = codec.build
/** Parse every conversation reference out of `text`, in document order. */
export const parseConversationRefs = codec.parse
/** Match a conversation reference at the START of `src`, or null. */
export const matchLeadingConversationRef = codec.matchLeading

/** Distinct referenced conversation ids (order-preserving). */
export function referencedConversationIds(text: string): string[] {
  const seen = new Set<string>()
  for (const ref of parseConversationRefs(text)) seen.add(ref.id)
  return [...seen]
}

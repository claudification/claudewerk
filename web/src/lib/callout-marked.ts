/**
 * `marked` inline extension for SOTU `<callout>` tags -- the WEB half of the
 * Phase 3 emit channel (RENDER).
 *
 * A callout can appear MID-SENTENCE, so it is rendered as an INLINE element (like
 * `<mark>`) -- the surrounding prose is NEVER mangled or pulled out. The body is
 * parsed as inline markdown so it reads as part of the sentence; a per-type styled
 * chip just signals "this bit was a SOTU contribution".
 *
 * This is a DIFFERENT seam from `transcript/grouping/parsers.ts` (that one is
 * block-level, anchored to whole-entry content like `<channel>`). The grammar is
 * shared with the agent-host scanner via `@shared/sotu-callout` so the parse used
 * to COLLECT a callout and the parse used to RENDER it can never drift.
 */

import { matchLeadingCallout } from '@shared/sotu-callout'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Build the inline callout chip. `innerHtml` is the already-rendered inline
 *  markdown body. A `lock` carries its claimed path in a tooltip + data attr. */
function renderCalloutSpan(type: string, innerHtml: string, path?: string): string {
  const pathAttr = path ? ` data-callout-path="${escapeAttr(path)}" title="claim: ${escapeAttr(path)}"` : ''
  return `<span class="sotu-callout sotu-callout-${type}" data-callout-type="${escapeAttr(type)}"${pathAttr}>${innerHtml}</span>`
}

// biome-ignore lint/suspicious/noExplicitAny: marked's extension API uses loose token typing
type AnyToken = any

/** The marked inline extension. Register it via `marked.use({ extensions: [calloutInlineExtension] })`. */
export const calloutInlineExtension = {
  name: 'callout',
  level: 'inline' as const,
  start(src: string) {
    const i = src.indexOf('<callout')
    return i < 0 ? undefined : i
  },
  // biome-ignore lint/suspicious/noExplicitAny: marked tokenizer `this` (lexer) is untyped in public types
  tokenizer(this: any, src: string) {
    const hit = matchLeadingCallout(src)
    if (!hit) return undefined
    const token: AnyToken = {
      type: 'callout',
      raw: hit.raw,
      calloutType: hit.type,
      path: hit.path,
      text: hit.payload,
      tokens: [],
    }
    this.lexer.inlineTokens(hit.payload, token.tokens)
    return token
  },
  // biome-ignore lint/suspicious/noExplicitAny: marked renderer `this` (parser) is untyped in public types
  renderer(this: any, token: AnyToken) {
    const inner = this.parser.parseInline(token.tokens) as string
    return renderCalloutSpan(token.calloutType, inner, token.path)
  },
}

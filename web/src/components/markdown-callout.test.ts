import { Marked } from 'marked'
import { describe, expect, test } from 'vitest'
import { calloutInlineExtension } from '@/lib/callout-marked'

// Replicates the SOTU-relevant slice of markdown.tsx's marked config: the
// preprocess angle-bracket escaper (which must pass `<callout>` through) plus the
// inline callout extension itself. Proves a mid-sentence callout renders as a
// styled inline span with the surrounding prose left whole (Phase 3 RENDER).
const marked = new Marked()
marked.setOptions({ gfm: true, breaks: true, async: false })

// Same preprocess as markdown.tsx: escape angle-bracket tags EXCEPT conversation
// + callout tokens (the inline extensions consume those).
marked.use({
  hooks: {
    preprocess(src: string) {
      const parts = src.split(/(^```[^\n]*\n[\s\S]*?\n```$|`[^`\n]+`)/gm)
      return parts
        .map((part, i) => {
          if (i % 2 === 1) return part
          return part.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)>/g, (full, inner: string) =>
            /^\/?(?:conversation|callout)(?:\s|$)/.test(inner) ? full : `&lt;${inner}&gt;`,
          )
        })
        .join('')
    },
  },
})
marked.use({ extensions: [calloutInlineExtension] })

function inline(src: string): string {
  return marked.parseInline(src) as string
}

describe('inline <callout> rendering', () => {
  test('renders a mid-sentence callout as a styled inline span, prose intact', () => {
    const html = inline('The auth path <callout type="insight">permissions.ts is dead code</callout> since v6.')
    // The styled inline span carries the type class + data attr.
    expect(html).toContain('<span class="sotu-callout sotu-callout-insight" data-callout-type="insight">')
    expect(html).toContain('permissions.ts is dead code</span>')
    // The surrounding sentence is untouched (never stripped / orphaned).
    expect(html).toContain('The auth path ')
    expect(html).toContain(' since v6.')
    // It is INLINE -- no block wrapper was introduced around the callout.
    expect(html).not.toContain('<div')
  })

  test('renders a lock callout with its claim path in a tooltip + data attr', () => {
    const html = inline('<callout type="lock" path="src/broker/permissions.ts">refactoring, ~1h</callout>')
    expect(html).toContain('class="sotu-callout sotu-callout-lock"')
    expect(html).toContain('data-callout-path="src/broker/permissions.ts"')
    expect(html).toContain('title="claim: src/broker/permissions.ts"')
    expect(html).toContain('refactoring, ~1h</span>')
  })

  test('parses inline markdown inside the callout body', () => {
    const html = inline('<callout type="insight">the `auth` check</callout>')
    expect(html).toContain('<code>auth</code>')
  })

  test('renders every callout type with its own class', () => {
    for (const t of ['insight', 'lock', 'blocked', 'focus', 'dead-end']) {
      const html = inline(`<callout type="${t}">body</callout>`)
      expect(html).toContain(`sotu-callout-${t}`)
      expect(html).toContain(`data-callout-type="${t}"`)
    }
  })

  test('leaves a NON-callout angle-bracket tag escaped (the exception is narrow)', () => {
    const html = marked.parse('a <foo> tag and a <callout type="focus">real</callout> one') as string
    expect(html).toContain('&lt;foo&gt;')
    expect(html).toContain('class="sotu-callout sotu-callout-focus"')
  })

  test('an unknown callout type is NOT rendered as a callout span (body text survives)', () => {
    // The extension rejects an unknown type (matchLeadingCallout returns null), so
    // no styled span is produced -- the body text just renders as-is. (Inner HTML
    // tags would still be escaped by the preprocess; only the inert <callout>
    // wrapper passes through, same precedent as the <conversation> token.)
    const html = marked.parse('<callout type="bogus">body text</callout>') as string
    expect(html).not.toContain('class="sotu-callout')
    expect(html).toContain('body text')
  })

  test('renders two callouts in one sentence independently', () => {
    const html = inline('<callout type="focus">A</callout> and <callout type="blocked">B</callout>')
    expect(html).toContain('sotu-callout-focus')
    expect(html).toContain('sotu-callout-blocked')
    expect(html).toContain(' and ')
  })
})
